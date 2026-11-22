// Conditional fields and formulas: the formula reader and what it works out, which fields are shown, loops, what the
// server does with a browser that says something else, the signed PDF, sign-again after a rule changes, templates,
// clones, public forms, bulk send and the API.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, signUp, upload, tokenFor, PNG, type Server } from './helpers.ts';
import { parseFormula, evaluate, readNumber, formatNumber, roundTo, workOut, loopsIn, logicWarnings, ruleWords, formulaWords, logicKey, FormulaError } from '../src/lib/logic.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

let n = 0;
const person = (name: string, email: string) => signUp(name, email, `10.77.${++n}.9`);

// A formula worked out with plain values: a name in curly brackets is its own value.
const calc = (src: string, vals: Record<string, any> = {}) => evaluate(parseFormula(src), (id) => (Object.hasOwn(vals, id) ? (typeof vals[id] === 'number' ? { num: vals[id] } : { text: vals[id] }) : null), (id) => id);
const refused = (src: string) => {
  try {
    parseFormula(src);
  } catch (e: any) {
    assert.ok(e instanceof FormulaError, `${src}: ${e}`);
    return e.message as string;
  }
  assert.fail(`${JSON.stringify(src)} was read as a formula`);
};

// ---- The formula reader ------------------------------------------------------------------------------------

test('a formula: * and / before + and -, brackets first, a minus in front, sum of a list and rounding', () => {
  assert.equal(calc('2 + 3 * 4').value, 14);
  assert.equal(calc('(2 + 3) * 4').value, 20);
  assert.equal(calc('10 - 4 - 3').value, 3, 'left to right');
  assert.equal(calc('100 / 10 / 5').value, 2, 'left to right');
  assert.equal(calc('-2 * -3').value, 6);
  assert.equal(calc('2 - -3').value, 5);
  assert.equal(calc('((((1 + 1))))').value, 2);
  assert.equal(calc('2 × 3 ÷ 4 − 1').value, 0.5, 'the signs people write work as well');
  assert.equal(calc('sum({a}, {b}, {c})', { a: '1', b: '2,5', c: '' }).value, 3.5);
  assert.equal(calc('sum({a}; {b})', { a: '1', b: '2' }).value, 3, 'a semicolon separates as well');
  assert.equal(calc('round({a} / 3, 2)', { a: '10' }).text, '3.33');
  assert.equal(calc('round({a}, 2)', { a: '12,5' }).text, '12,50', 'round(..., 2) always shows two decimals, with the mark the number was typed with');
  assert.equal(calc('round({a}, 0)', { a: '2.5' }).value, 3, 'half away from zero');
  assert.equal(calc('round({a}, 0)', { a: '-2.5' }).value, -3);
  assert.equal(roundTo(1.005, 2), 1.01, 'on the number as written, not its binary neighbour');
  assert.equal(calc('{a} + {b}', { a: '0.1', b: '0.2' }).text, '0.3', 'no 0.30000000000000004');
  assert.equal(calc('{a} * {b}', { a: '19.99', b: '3' }).text, '59.97');
});

test('numbers as people write them are read, and the result is written the same way', () => {
  assert.equal(readNumber('1.234,56')!.value, 1234.56);
  assert.equal(readNumber('1 234,56')!.value, 1234.56);
  assert.equal(readNumber("1'234.56")!.value, 1234.56);
  assert.equal(readNumber('1,23,456')!.value, 123456);
  assert.equal(readNumber('€1.234,56')!.value, 1234.56);
  assert.equal(readNumber('1 234,56 kr')!.value, 1234.56);
  assert.equal(readNumber('-40')!.value, -40);
  assert.equal(readNumber('١٢٣')!.value, 123, 'digits of another script');
  assert.equal(readNumber('0,125')!.value, 0.125);
  assert.equal(readNumber('12 apples'), null);
  // One mark and three digits is either. Alone it is read as thousands and said so; another number decides it.
  assert.equal(readNumber('1,234')!.value, 1234);
  assert.equal(readNumber('1,234')!.ambiguous, ',');
  assert.equal(readNumber('1,234', ',')!.value, 1.234);
  assert.match(calc('{a} * 2', { a: '1.234' }).ambiguous.join(' '), /'a' \(1\.234\) is read as 1234/);
  assert.equal(calc('{a} + {b}', { a: '1.234', b: '0,5' }).value, 1234.5, 'the comma before decimals elsewhere says the dot groups thousands');
  assert.equal(calc('{a} + {b}', { a: '1.234,50', b: '100' }).text, '1.334,5');
  assert.equal(calc('{a} * 2', { a: '1 234,50' }).text, '2 469');
  assert.equal(calc('{a} * 1', { a: '12,34,567.50' }).text, '12,34,567.5', 'Indian grouping stays Indian');
  assert.equal(formatNumber(1234567.891, { dec: ',', group: '.', indian: false }), '1.234.567,891');
});

test('empty inputs count as 0, all empty gives nothing, dividing by 0 says so, and nothing too big or too small is made up', () => {
  assert.equal(calc('{a} * {b}', { a: '3', b: '' }).value, 0, 'an empty field counts as 0');
  const none = calc('{a} + {b}', { a: '', b: '' });
  assert.equal(none.value, null);
  assert.equal(none.empty, true, 'every field empty: nothing is worked out yet, and that is not an error');
  assert.equal(none.error, null);
  const div = calc('{a} / {b}', { a: '10', b: '' });
  assert.equal(div.value, null);
  assert.match(div.error!, /divide by 0, because 'b' is 0 or empty/);
  assert.match(calc('{a} / ({b} - {b})', { a: '1', b: '5' }).error!, /divide by 0, because a part of it comes to 0/);
  assert.match(calc('{a} * {a}', { a: '99999999' }).error!, /too large to work out exactly/, '10^15 and above is said, not rounded');
  assert.match(calc('{a} + 1', { a: '1234567890123456' }).error!, /more than 15 digits/);
  assert.equal(calc('{a} * {b}', { a: '0.000001', b: '0.000001' }).text, '0', 'below the tenth decimal it is 0, not 1e-12');
  assert.equal(calc('{a} * 1', { a: '0.0000000001' }).text, '0.0000000001');
  assert.equal(calc('{a} * 1', { a: '999999999999999' }).text, '999999999999999');
  assert.match(calc('{a} + 1', { a: 'twelve' }).error!, /'a' does not read as a number/);
  assert.match(calc('{t} + 1', { t: 5 }).text!, /^6$/, 'another calculated field gives its number');
});

test('a formula is never run as code, and what it cannot read is refused in words', () => {
  for (const src of ['constructor', 'alert(1)', 'process.exit(1)', 'this', 'Function("x")', '__proto__', '[1,2]', '"x"', '2 ** 3', '1; 2', 'a = 1', '`x`', '{a} && {b}', 'eval(1)'])
    refused(src);
  assert.match(refused(''), /The formula is empty/);
  assert.match(refused('1 +'), /Something is missing at the end after "\+"/);
  assert.match(refused('(1 + 2'), /A closing bracket \) is missing/);
  assert.match(refused('1 + 2)'), /closing bracket \) with no opening one/);
  assert.match(refused('avg({a})'), /"avg" is not something a formula knows/);
  assert.match(refused('round({a})'), /round needs what to round and a whole number of decimals from 0 to 10/);
  assert.match(refused('round({a}, 11)'), /from 0 to 10/);
  assert.match(refused('{a'), /never closed with \}/);
  assert.match(refused('{}'), /empty \{\}/);
  assert.match(refused('1,5 * 2'), /Write decimals with a dot/);
  assert.match(refused('{a}{b}'), /nothing between them/);
  assert.match(refused('x'.repeat(501)), /most it can be is 500/);
  assert.match(refused(`${'('.repeat(30)}1${')'.repeat(30)}`), /more than 20 brackets/);
  assert.match(refused(`${'-'.repeat(30)}1`), /more than 20 signs/);
  // A field named like a property of every object is just a name that is looked up, and it names nothing.
  assert.equal(calc('{constructor} + {__proto__} + {a}', { a: '1' }).value, 1);
});

// ---- Which fields are shown ---------------------------------------------------------------------------------

const F = (id: string, type: string, extra: any = {}) => ({ id, type, recipient_id: 'r', value: null, ...extra });

test('rules chain from the top: a field is shown only when the one it depends on is shown and has the answer', () => {
  const fields: any[] = [
    F('co', 'checkbox', { label: 'Has a co-signer' }),
    F('name', 'text', { label: 'Co-signer name', show_when: { field: 'co', is: 'checked' } }),
    F('why', 'text', { show_when: { field: 'name', is: 'equals', value: 'bob' } }),
    F('plan', 'dropdown', { options: ['Gold', 'Silver'] }),
    F('gold', 'text', { show_when: { field: 'plan', is: 'equals', value: 'gold' } }),
    F('notgold', 'text', { show_when: { field: 'plan', is: 'not_equals', value: 'Gold' } }),
    F('qty', 'number'),
    F('lots', 'text', { show_when: { field: 'qty', is: 'more_than', value: '1.000' } }),
    F('few', 'text', { show_when: { field: 'qty', is: 'less_than', value: '10' } }),
    F('a', 'radio', { group_name: 'g' }), F('b', 'radio', { group_name: 'g' }),
    F('ifb', 'text', { show_when: { field: 'b', is: 'checked' } }),
  ];
  const hidden = (vals: Record<string, any>) => [...workOut(fields.map((f) => ({ ...f, value: vals[f.id] ?? null }))).hidden].sort();
  assert.deepEqual(hidden({}), ['few', 'gold', 'ifb', 'lots', 'name', 'why'].sort());
  assert.deepEqual(hidden({ co: '1', name: ' BOB ', plan: 'Gold', qty: '1.500', b: '1' }), ['few', 'notgold'], 'case and spaces do not matter, 1.500 is more than 1.000');
  assert.deepEqual(hidden({ co: '', name: 'Bob', plan: 'Silver', qty: '5' }).sort(), ['gold', 'ifb', 'lots', 'name', 'why'].sort(), 'unticking hides the whole chain below it');
  assert.equal(ruleWords({ field: 'co', is: 'checked' }, fields[0], 'Has a co-signer'), "Shown when 'Has a co-signer' is ticked");
  assert.equal(ruleWords({ field: 'b', is: 'checked' }, fields[10], 'Yes'), "Shown when 'Yes' is chosen");
  assert.equal(ruleWords({ field: 'qty', is: 'more_than', value: '100' }, fields[6], 'Quantity'), "Shown when 'Quantity' is more than 100");
  assert.equal(formulaWords('{q} * {p} / 2', (id) => ({ q: 'Quantity', p: 'Unit price' } as any)[id]), "'Quantity' × 'Unit price' ÷ 2");
  const nm = (id: string) => id.toUpperCase();
  assert.equal(formulaWords('(({a} + {b})) * {c}', nm), "('A' + 'B') × 'C'", 'brackets only where they change something');
  assert.equal(formulaWords('{a} - ({b} - {c})', nm), "'A' - ('B' - 'C')");
  assert.equal(formulaWords('{a} - {b} - {c}', nm), "'A' - 'B' - 'C'");
  assert.equal(formulaWords('round(sum({a}, {b}) / 3, 2)', nm), "sum('A', 'B') ÷ 3, rounded to 2 decimals");
  assert.equal(formulaWords('sum({a}, {b})', nm), "the sum of 'A', 'B'");
  assert.equal(formulaWords('{a} *', nm), "'A' ×", 'a formula still being typed is shown as it is');
});

test('a calculated field that is hidden counts as empty, rules can depend on a calculated field, and loops are found', () => {
  const fields: any[] = [
    F('q', 'number', { value: '10' }), F('p', 'number', { value: '12,50', readonly: 1 }),
    F('t', 'number', { formula: 'round({q} * {p}, 2)' }),
    F('why', 'text', { show_when: { field: 't', is: 'more_than', value: '100' } }),
    F('vip', 'checkbox'), F('disc', 'number', { value: '5', show_when: { field: 'vip', is: 'checked' } }),
    F('net', 'number', { formula: '{t} - {disc}' }),
  ];
  const o = workOut(fields);
  assert.equal(o.calc.get('t')!.text, '125,00');
  assert.ok(!o.hidden.has('why'), 'shown: 125 is more than 100');
  assert.ok(o.hidden.has('disc'));
  assert.equal(o.calc.get('net')!.value, 125, 'the hidden discount counts as empty');
  assert.equal(workOut(fields.map((f) => (f.id === 'vip' ? { ...f, value: '1' } : f))).calc.get('net')!.value, 120);
  assert.deepEqual(loopsIn([F('a', 'number', { formula: '{b} + 1' }), F('b', 'number', { formula: '{a}' })]), [['a', 'b']]);
  assert.deepEqual(loopsIn([F('x', 'text', { show_when: { field: 'y', is: 'filled' } }), F('y', 'text', { show_when: { field: 'x', is: 'filled' } })]), [['x', 'y']]);
  assert.deepEqual(loopsIn([F('s', 'number', { formula: '{s}' })]), [['s']]);
  assert.deepEqual(loopsIn(fields), []);
  // A loop that got in anyway is never shown and never worked out, rather than hanging.
  const looped = workOut([F('x', 'text', { show_when: { field: 'y', is: 'empty' } }), F('y', 'text', { show_when: { field: 'x', is: 'empty' } }), F('a', 'number', { formula: '{a} + 1' })]);
  assert.deepEqual([...looped.hidden].sort(), ['x', 'y']);
  assert.match(looped.calc.get('a')!.error!, /cannot be worked out/);
  // The key that sign-again compares is the same for the stored JSON and the object.
  assert.equal(logicKey({ show_when: '{"field":"co","is":"checked"}' }), logicKey({ show_when: { field: 'co', is: 'checked' } }));
  assert.equal(logicKey({}), '');
});

test('the review step names rules that can never be true and inputs the signer cannot reach', () => {
  const recipients = [{ id: 'r', name: 'Ada', role: 'signer', routing_order: 1 }, { id: 's', name: 'Ben', role: 'signer', routing_order: 2 }];
  const fields: any[] = [
    F('plan', 'dropdown', { label: 'Plan', options: ['Gold'] }),
    F('x', 'text', { label: 'Extra', show_when: { field: 'plan', is: 'equals', value: 'Platinum' } }),
    F('fixed', 'checkbox', { label: 'Agreed by sender', readonly: 1, value: '' }),
    F('y', 'text', { label: 'Terms', show_when: { field: 'fixed', is: 'checked' } }),
    F('z', 'text', { label: 'More terms', show_when: { field: 'y', is: 'filled' } }),
    F('ship', 'number', { label: 'Shipping', readonly: 1 }),
    F('bq', 'number', { label: 'Ben quantity', recipient_id: 's' }),
    F('t', 'number', { label: 'Total', formula: '{ship} + {bq}' }),
  ];
  const said = logicWarnings(fields, recipients, true, (f) => f.label).join('\n');
  assert.match(said, /'Extra' for Ada will never be shown: 'Plan' has no choice "Platinum"/);
  assert.match(said, /'Terms' for Ada will never be shown: 'Agreed by sender' is filled in by the sender and cannot be changed/);
  assert.match(said, /'More terms' for Ada will never be shown: 'Terms' is never shown itself/);
  assert.match(said, /'Total' uses 'Shipping', which is read only and empty, so it always counts as 0/);
  assert.match(said, /'Total' \(for Ada\) uses 'Ben quantity', which Ben fills in\. Unless Ben has finished first, it counts as 0/);
  // Ben signing first is fine.
  assert.doesNotMatch(logicWarnings(fields, [{ ...recipients[0], routing_order: 2 }, { ...recipients[1], routing_order: 1 }], true, (f) => f.label).join('\n'), /Ben quantity/);
});

// ---- On the server ------------------------------------------------------------------------------------------

// One signer with a quote on the page: a tick box with a co-signer behind it, a quantity, the sender's price, a total
// worked out from both, and a question that only comes for a large order.
async function quote(c: Client, email: string, over: any = {}) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: 'Order form',
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', name: 'Ada Buyer', email }],
    fields: [
      { id: 'sig', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.85, w: 0.3, h: 0.06 },
      { id: 'co', document_id: 'd', recipient_id: 'r', type: 'checkbox', label: 'Has a co-signer', required: false, page: 0, x: 0.1, y: 0.1, w: 0.03, h: 0.02 },
      { id: 'coname', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Co-signer name', page: 0, x: 0.1, y: 0.15, w: 0.3, h: 0.03, show_when: { field: 'co', is: 'checked' } },
      { id: 'cosig', document_id: 'd', recipient_id: 'r', type: 'initials', label: 'Co-signer initials', page: 0, x: 0.5, y: 0.15, w: 0.1, h: 0.04, show_when: { field: 'co', is: 'checked' } },
      { id: 'qty', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Quantity', page: 0, x: 0.1, y: 0.3, w: 0.2, h: 0.03 },
      { id: 'price', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Unit price', readonly: true, value: '12,50', page: 0, x: 0.4, y: 0.3, w: 0.2, h: 0.03 },
      { id: 'total', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Total', formula: 'round({Quantity} * {Unit price}, 2)', page: 0, x: 0.7, y: 0.3, w: 0.2, h: 0.03 },
      { id: 'why', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Reason for a large order', page: 0, x: 0.1, y: 0.4, w: 0.5, h: 0.03, show_when: { field: 'total', is: 'more_than', value: '100' } },
    ],
    ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const fieldsOf = (eid: string) => Object.fromEntries(db.all('SELECT * FROM fields WHERE envelope_id=?', eid).map((f: any) => [f.label || f.type, f]));
async function opened(eid: string, email: string) {
  const c = new Client();
  const tok = tokenFor(eid, email);
  assert.equal((await c.post(`/sign/${tok}/consent`)).status, 200);
  const v = (await c.get(`/sign/${tok}`)).data;
  // marks: the signature and initials fields as the signing page sends them once they are placed.
  const marks = Object.fromEntries(v.fields.filter((f: any) => f.type === 'signature' || f.type === 'initials').map((f: any) => [f.id, '1']));
  return { c, tok, v, marks, id: (label: string) => v.fields.find((f: any) => f.label === label)?.id };
}
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

test('saved by label, stored by id, given back as an object, and the total is worked out from what is stored', async () => {
  const s = await person('Sam Seller', 'sam@logic.example');
  const e = await quote(s, 'ada@logic.example');
  const got = (await s.get(`/envelopes/${e.id}`)).data.envelope;
  const by = (l: string) => got.fields.find((f: any) => f.label === l);
  assert.deepEqual(by('Co-signer name').show_when, { field: by('Has a co-signer').id, is: 'checked' }, 'an object, naming the field by its id');
  assert.equal(by('Total').formula, `round({${by('Quantity').id}} * {${by('Unit price').id}}, 2)`, 'the labels became ids');
  assert.equal(by('Total').required, 0, 'a calculated field is never required');
  assert.deepEqual(by('Reason for a large order').show_when, { field: by('Total').id, is: 'more_than', value: '100' });
  // Saving it back as it came is no change at all, also to the rules.
  const again = await s.put(`/envelopes/${e.id}`, { fields: got.fields });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.deepEqual((await s.get(`/envelopes/${e.id}`)).data.envelope.fields.map((f: any) => [f.label, f.show_when, f.formula]).sort(), got.fields.map((f: any) => [f.label, f.show_when, f.formula]).sort());
});

test('a loop, a field of another person and a formula that cannot be read are refused when saved, naming the fields', async () => {
  const s = await person('Lou Loop', 'lou@logic.example');
  const file = await upload(s, 1);
  const base = (fields: any[], recipients = [{ id: 'r', name: 'Ada', email: 'ada2@logic.example' }]) => s.post('/envelopes', { documents: [{ id: 'd', file_id: file.id }], recipients, fields: fields.map((f) => ({ document_id: 'd', recipient_id: 'r', page: 0, x: 0.1, y: Math.random() * 0.8, w: 0.2, h: 0.03, ...f })) });
  let r = await base([{ id: 'a', type: 'number', label: 'Subtotal', formula: '{Total} - 5' }, { id: 'b', type: 'number', label: 'Total', formula: '{Subtotal} + 5' }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /These fields depend on each other in a circle.*'Subtotal' is worked out from 'Total'; 'Total' is worked out from 'Subtotal'.*Nothing was saved/);
  r = await base([{ id: 'x', type: 'text', label: 'Left', show_when: { field: 'y', is: 'filled' } }, { id: 'y', type: 'text', label: 'Right', show_when: { field: 'Left', is: 'empty' } }]);
  assert.match(r.data.error, /'Left' is shown depending on 'Right'; 'Right' is shown depending on 'Left'/);
  r = await base([{ id: 'c', type: 'number', label: 'Net', formula: '{Tax} + 1' }, { id: 't', type: 'number', label: 'Tax', show_when: { field: 'Net', is: 'more_than', value: '5' } }]);
  assert.match(r.data.error, /'Net' is worked out from 'Tax'; 'Tax' is shown depending on 'Net'/, 'a rule and a formula can make a circle together');
  r = await base([{ id: 'self', type: 'text', label: 'Me', show_when: { field: 'self', is: 'filled' } }]);
  assert.match(r.data.error, /shown when it has an answer itself/);
  r = await base([{ id: 'box', type: 'checkbox', label: 'Ben agrees', recipient_id: 'r2' }, { id: 'n', type: 'text', label: 'Ada note', show_when: { field: 'box', is: 'checked' } }], [{ id: 'r', name: 'Ada', email: 'ada2@logic.example' }, { id: 'r2', name: 'Ben', email: 'ben2@logic.example' }] as any);
  assert.match(r.data.error, /belongs to Ada, and the field it depends on, 'Ben agrees', belongs to Ben\. A field can only depend on an answer of the same person/);
  r = await base([{ id: 'box', type: 'checkbox', label: 'Box' }, { id: 'n', type: 'text', show_when: { field: 'box', is: 'more_than', value: '3' } }]);
  assert.match(r.data.error, /for 'Box', a tick box field, it can be "checked" \(is ticked\), "unchecked" \(is not ticked\)/);
  r = await base([{ id: 'q', type: 'number', label: 'Qty' }, { id: 'n', type: 'text', show_when: { field: 'q', is: 'more_than', value: 'lots' } }]);
  assert.match(r.data.error, /"lots" is not a number, so 'Qty' cannot be compared with it/);
  r = await base([{ id: 'q', type: 'number', label: 'Qty' }, { id: 'n', type: 'text', show_when: { field: 'q', is: 'equals' } }]);
  assert.match(r.data.error, /compares 'Qty' with a value, and "value" is missing/);
  r = await base([{ id: 'n', type: 'text', show_when: { field: 'Nothing like it', is: 'filled' } }]);
  assert.match(r.data.error, /is shown when "Nothing like it", and no field on this envelope has that id or label/);
  r = await base([{ id: 'n', type: 'text', show_when: 'when ticked' }]);
  assert.match(r.data.error, /"show_when" must be an object/);
  r = await base([{ id: 'n', type: 'text', label: 'Words', formula: '1 + 1' }]);
  assert.match(r.data.error, /'Words'|"Words"/);
  assert.match(r.data.error, /Only a number field can be worked out from a formula/);
  r = await base([{ id: 'n', type: 'number', label: 'Sum', formula: '{Qty} +' }, { id: 'q', type: 'number', label: 'Qty' }]);
  assert.match(r.data.error, /the formula cannot be read\. Something is missing at the end after "\+"/);
  r = await base([{ id: 'n', type: 'number', label: 'Sum', formula: '{Name} + 1' }, { id: 'q', type: 'text', label: 'Name' }]);
  assert.match(r.data.error, /The field called that is not one that can be used here/);
  r = await base([{ id: 'n', type: 'number', label: 'Sum', formula: '{Amount} + 1' }, { id: 'a1', type: 'number', label: 'Amount' }, { id: 'a2', type: 'number', label: 'amount' }]);
  assert.match(r.data.error, /2 fields have that label\. Give them different labels, or name the field by its id/);
  r = await base([{ type: 'note', value: 'Hi', show_when: { field: 'x', is: 'filled' } }]);
  assert.match(r.data.error, /note: the sender's own wording, which is always on the page/);
  assert.equal(db.get("SELECT COUNT(*) n FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE u.email='lou@logic.example'").n, 0, 'nothing was saved by any of them');
});

test('the server decides: a hidden required field is not required, its answer is dropped, a calculated value from the browser is ignored, and the PDF prints what was shown', async () => {
  const s = await person('Sue Seller', 'sue@logic.example');
  const e = await quote(s, 'ada3@logic.example');
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const { c, tok, id } = await opened(e.id, 'ada3@logic.example');
  // A browser that lies the other way: the box is ticked, so the co-signer's name is required, whatever it leaves out.
  const sig = { [id(undefined as any) || (await c.get(`/sign/${tok}`)).data.fields.find((f: any) => f.type === 'signature').id]: '1' };
  let r = await c.post(`/sign/${tok}/complete`, { values: { ...sig, [id('Has a co-signer')!]: '1', [id('Quantity')!]: '3' }, signature_png: PNG, initials_png: PNG });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /A required field is still empty: Co-signer name/);
  // A large order: the question appears, worked out by the server from the stored quantity and the sender's price.
  r = await c.post(`/sign/${tok}/save`, { values: { [id('Quantity')!]: '10', [id('Total')!]: '1' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fieldsOf(e.id).Total.value, '125,00', 'the browser said 1, the server worked out 125,00');
  r = await c.post(`/sign/${tok}/complete`, { values: { ...sig, [id('Quantity')!]: '10' }, signature_png: PNG });
  assert.match(r.data.error, /A required field is still empty: Reason for a large order/);
  // Unticked, with a co-signer's name and initials sent anyway, and a total the browser made up. Quantity 3: no question.
  r = await c.post(`/sign/${tok}/complete`, { values: { ...sig, [id('Has a co-signer')!]: '', [id('Co-signer name')!]: 'Mallory Mallet', [id('Co-signer initials')!]: '1', [id('Quantity')!]: '3', [id('Total')!]: '999999', [id('Reason for a large order')!]: 'Sneaky words' }, signature_png: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = fieldsOf(e.id);
  assert.equal(f['Co-signer name'].value, null, 'the answer to a hidden field is not kept');
  assert.equal(f['Co-signer initials'].value, null, 'no initials needed, none placed');
  assert.equal(f['Reason for a large order'].value, null);
  assert.equal(f.Total.value, '37,50');
  const pdf = (await s.get(`/envelopes/${e.id}/download`)).data;
  const words = await pdfText(pdf);
  assert.match(words, /37,50/, 'the calculated total is printed');
  assert.match(words, /12,50/, 'and the price it came from');
  assert.doesNotMatch(words, /Mallory|Sneaky|999999/, 'nothing of a hidden field and nothing the browser made up');
});

test('a signature field the signer\'s own answer hides is not asked for, and one it shows is', async () => {
  const s = await person('Hal Host', 'hal@logic.example');
  const file = await upload(s, 1);
  const e = (await s.post('/envelopes', {
    documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', name: 'Gil Guest', email: 'gil@logic.example' }],
    fields: [
      { id: 'x', document_id: 'd', recipient_id: 'r', type: 'checkbox', label: 'I sign for a company', required: false, page: 0, x: 0.1, y: 0.1, w: 0.03, h: 0.02 },
      { id: 'company', document_id: 'd', recipient_id: 'r', type: 'company', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03, show_when: { field: 'x', is: 'checked' } },
      { id: 'sig', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.06, show_when: { field: 'x', is: 'checked' } },
      { id: 'own', document_id: 'd', recipient_id: 'r', type: 'initials', page: 0, x: 0.5, y: 0.6, w: 0.1, h: 0.04 },
    ],
  })).data.envelope;
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const { c, tok, id } = await opened(e.id, 'gil@logic.example');
  const mine = (await c.get(`/sign/${tok}`)).data.fields;
  const box = mine.find((f: any) => f.type === 'checkbox').id, own = mine.find((f: any) => f.type === 'initials').id;
  let r = await c.post(`/sign/${tok}/complete`, { values: { [box]: '1', [own]: '1' }, initials_png: PNG });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Your signature is missing\. Make it on the page, then finish again\./, 'ticked: the signature is needed');
  r = await c.post(`/sign/${tok}/complete`, { values: { [box]: '', [own]: '1' }, initials_png: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(id('x'), undefined);
  const progress = (await s.get(`/envelopes/${e.id}`)).data.envelope.recipients[0].progress;
  assert.equal(progress.fields, 2, 'the sender counts the box and the initials, not the hidden company and signature');
});

test('after someone has finished, a changed rule or formula changes what they signed, so it needs the sign-again choice', async () => {
  const s = await person('Rita Rules', 'rita@logic.example');
  const file = await upload(s, 1);
  const e = (await s.post('/envelopes', {
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r1', name: 'Ann First', email: 'ann@logic.example' }, { id: 'r2', name: 'Bob Second', email: 'bob@logic.example' }],
    fields: [
      { id: 's1', document_id: 'd', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
      { id: 'box', document_id: 'd', recipient_id: 'r2', type: 'checkbox', label: 'Extra cover', required: false, page: 0, x: 0.1, y: 0.1, w: 0.03, h: 0.02 },
      { id: 'cover', document_id: 'd', recipient_id: 'r2', type: 'text', label: 'Cover details', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03, show_when: { field: 'box', is: 'checked' } },
      { id: 'q', document_id: 'd', recipient_id: 'r2', type: 'number', label: 'Months', page: 0, x: 0.1, y: 0.3, w: 0.2, h: 0.03 },
      { id: 't', document_id: 'd', recipient_id: 'r2', type: 'number', label: 'Price', formula: '{Months} * 10', page: 0, x: 0.4, y: 0.3, w: 0.2, h: 0.03 },
      { id: 's2', document_id: 'd', recipient_id: 'r2', type: 'signature', page: 0, x: 0.5, y: 0.8, w: 0.3, h: 0.06 },
    ],
  })).data.envelope;
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const ann = await opened(e.id, 'ann@logic.example');
  assert.equal((await ann.c.post(`/sign/${ann.tok}/complete`, { values: { [ann.v.fields[0].id]: '1' }, signature_png: PNG })).status, 200);
  const now = (await s.get(`/envelopes/${e.id}`)).data.envelope;
  // The rule changes from "ticked" to "not ticked". Nothing else does.
  const changed = now.fields.map((f: any) => (f.label === 'Cover details' ? { ...f, show_when: { ...f.show_when, is: 'unchecked' } } : f));
  let r = await s.put(`/envelopes/${e.id}`, { fields: changed });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, 'sign_again');
  assert.deepEqual(r.data.sign_again, ['Ann First']);
  assert.match(r.data.error, /When 'Cover details' on page 1 is shown changed\. Before: Shown when 'Extra cover' is ticked\. Now: Shown when 'Extra cover' is not ticked\./);
  assert.equal(db.get("SELECT status FROM recipients WHERE email='ann@logic.example'").status, 'completed', 'nothing was saved');
  // The formula is the same: it changes what Bob is charged, and so what Ann agreed to.
  // Only the number at the end changes (a field id can hold "10" too, by chance).
  r = await s.put(`/envelopes/${e.id}`, { fields: now.fields.map((f: any) => (f.label === 'Price' ? { ...f, formula: f.formula.replace(/\* 10$/, '* 12') } : f)) });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(r.data.error, /'Price' on page 1 is now worked out as 'Months' × 12, not 'Months' × 10/);
  r = await s.put(`/envelopes/${e.id}`, { fields: changed, resign: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const annNow = db.get("SELECT status, signed_before FROM recipients WHERE email='ann@logic.example'");
  assert.notEqual(annNow.status, 'completed', 'Ann is asked to sign again');
  assert.ok(annNow.signed_before);
  assert.ok(db.all('SELECT detail FROM audit WHERE envelope_id=? AND action=?', e.id, 'Envelope corrected').some((a: any) => /Shown when 'Extra cover' is not ticked/.test(a.detail)), 'the audit trail says what changed in words');
  // Moving nothing and changing nothing is still no change.
  const later = (await s.get(`/envelopes/${e.id}`)).data.envelope;
  assert.equal((await s.put(`/envelopes/${e.id}`, { fields: later.fields })).status, 200);
});

test('what someone else fills in counts once they have finished, and the result a signer signed never changes after', async () => {
  const s = await person('Tom Two', 'tom@logic.example');
  const file = await upload(s, 1);
  const e = (await s.post('/envelopes', {
    documents: [{ id: 'd', file_id: file.id }], ordered: true,
    recipients: [{ id: 'r1', name: 'Una Early', email: 'una@logic.example', routing_order: 1 }, { id: 'r2', name: 'Vic Late', email: 'vic@logic.example', routing_order: 2 }],
    fields: [
      { id: 'hours', document_id: 'd', recipient_id: 'r1', type: 'number', label: 'Hours', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.03 },
      { id: 'rate', document_id: 'd', recipient_id: 'r2', type: 'number', label: 'Rate', page: 0, x: 0.4, y: 0.1, w: 0.2, h: 0.03 },
      { id: 'due', document_id: 'd', recipient_id: 'r2', type: 'number', label: 'Amount due', formula: '{Hours} * {Rate}', page: 0, x: 0.7, y: 0.1, w: 0.2, h: 0.03 },
      { id: 'early', document_id: 'd', recipient_id: 'r1', type: 'number', label: 'Early guess', formula: '{Hours} * {Rate}', page: 0, x: 0.7, y: 0.2, w: 0.2, h: 0.03 },
      { id: 's1', document_id: 'd', recipient_id: 'r1', type: 'signature', page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
      { id: 's2', document_id: 'd', recipient_id: 'r2', type: 'signature', page: 0, x: 0.5, y: 0.8, w: 0.3, h: 0.06 },
    ],
  })).data.envelope;
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const una = await opened(e.id, 'una@logic.example');
  assert.equal((await una.c.post(`/sign/${una.tok}/complete`, { values: { ...una.marks, [una.id('Hours')!]: '8' }, signature_png: PNG })).status, 200);
  assert.equal(fieldsOf(e.id)['Early guess'].value, '0', "Vic's rate is not known when Una signs, so it counts as 0");
  const vic = await opened(e.id, 'vic@logic.example');
  // Vic's screen shows Una's finished hours, and the server works Vic's total out with them.
  assert.ok(vic.v.others.some((f: any) => f.label === 'Hours' && f.value === '8'));
  assert.equal((await vic.c.post(`/sign/${vic.tok}/save`, { values: { [vic.id('Rate')!]: '25' } })).status, 200);
  assert.equal(fieldsOf(e.id)['Amount due'].value, '200');
  assert.equal(fieldsOf(e.id)['Early guess'].value, '0', 'what Una signed does not change under her');
  assert.equal((await vic.c.post(`/sign/${vic.tok}/complete`, { values: { ...vic.marks, [vic.id('Rate')!]: '30', [vic.id('Amount due')!]: '1' }, signature_png: PNG })).status, 200);
  assert.equal(fieldsOf(e.id)['Amount due'].value, '240');
  assert.equal(fieldsOf(e.id)['Early guess'].value, '0');
  // A save that arrives for someone who has finished never touches their calculated field (the statement checks).
  const { settleLogic } = await import('../src/server/logic.ts');
  db.run("UPDATE fields SET value='9' WHERE envelope_id=? AND label='Hours'", e.id);
  settleLogic(e.id, null);
  assert.equal(fieldsOf(e.id)['Early guess'].value, '0');
});

// ---- Templates, copies, public forms and bulk send ---------------------------------------------------------------

// A plan form with one open role: a choice of plan, extras only for Gold, seats, the sender's seat price, a total.
async function planTemplate(c: Client) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    kind: 'template', subject: 'Plan form', documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'r', role: 'signer', role_name: 'Client' }],
    fields: [
      { id: 'sig', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.85, w: 0.3, h: 0.06 },
      { id: 'plan', document_id: 'd', recipient_id: 'r', type: 'dropdown', label: 'Plan', options: ['Gold', 'Silver'], page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.03 },
      { id: 'extras', document_id: 'd', recipient_id: 'r', type: 'text', label: 'Gold extras', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03, show_when: { field: 'plan', is: 'equals', value: 'Gold' } },
      { id: 'seats', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Seats', page: 0, x: 0.1, y: 0.3, w: 0.2, h: 0.03 },
      { id: 'each', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Seat price', readonly: true, value: '20', page: 0, x: 0.4, y: 0.3, w: 0.2, h: 0.03 },
      { id: 'total', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Total', formula: '{Seats} * {Seat price}', page: 0, x: 0.7, y: 0.3, w: 0.2, h: 0.03 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
// Every rule and formula of an envelope points at a field of that same envelope.
function pointsHome(eid: string) {
  const fields = db.all('SELECT id, label, show_when, formula FROM fields WHERE envelope_id=?', eid);
  const ids = new Set(fields.map((f: any) => f.id));
  const by = (l: string) => fields.find((f: any) => f.label === l);
  assert.equal(JSON.parse(by('Gold extras').show_when).field, by('Plan').id, `${eid}: the rule names this envelope's Plan`);
  assert.equal(by('Total').formula, `{${by('Seats').id}} * {${by('Seat price').id}}`);
  for (const f of fields) for (const m of String(f.formula || '').matchAll(/\{([^}]+)\}/g)) assert.ok(ids.has(m[1]));
}

test('rules and formulas go with templates, copies, public forms and bulk sends, and a bulk row can fill a field a rule depends on', async () => {
  const s = await person('Pat Plans', 'pat@logic.example');
  const tpl = await planTemplate(s);
  pointsHome(tpl.id);
  const used = await s.post('/envelopes', { template_id: tpl.id, recipients: { Client: { name: 'Cara Client', email: 'cara@logic.example' } } });
  assert.equal(used.status, 200, JSON.stringify(used.data));
  pointsHome(used.data.envelope.id);
  const clone = await s.post(`/envelopes/${used.data.envelope.id}/clone`, {});
  assert.equal(clone.status, 200, JSON.stringify(clone.data));
  pointsHome(clone.data.envelope?.id || clone.data.id);

  // A public form: the visitor's copy has the rules, and the server works it out for them.
  const form = await s.post('/powerforms', { template_id: tpl.id, name: 'Plans' });
  assert.equal(form.status, 200, JSON.stringify(form.data));
  const slug = db.get('SELECT slug FROM powerforms WHERE id=?', form.data.id).slug;
  const start = await Object.assign(new Client(), { ip: '10.78.0.1' }).post(`/public/powerforms/${slug}/start`, { name: 'Vera Visitor', email: 'vera@logic.example' });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const visit = db.get("SELECT e.id FROM envelopes e JOIN recipients r ON r.envelope_id=e.id WHERE r.email='vera@logic.example'").id;
  pointsHome(visit);
  const vera = await opened(visit, 'vera@logic.example');
  const r = await vera.c.post(`/sign/${vera.tok}/complete`, { values: { ...vera.marks, [vera.id('Plan')!]: 'Silver', [vera.id('Gold extras')!]: 'Free upgrade', [vera.id('Seats')!]: '4' }, signature_png: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fieldsOf(visit)['Gold extras'].value, null);
  assert.equal(fieldsOf(visit).Total.value, '80');

  // Bulk send: a column fills the plan. The Gold row asks for the extras, the Silver row does not.
  const bad = await s.post('/bulk', { template_id: tpl.id, rows: [{ Client: { name: 'Al', email: 'al@logic.example' }, fields: { Plan: 'Platinum' } }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Row 1: The column "Plan" holds "Platinum", which is not one of the choices of Plan: Gold, Silver\. Nothing was sent\./);
  assert.match((await s.post('/bulk', { template_id: tpl.id, rows: [{ Client: { name: 'Al', email: 'al@logic.example' }, fields: { Total: '5' } }] })).data.error, /is for Total, which is worked out by itself/);
  assert.match((await s.post('/bulk', { template_id: tpl.id, rows: [{ Client: { name: 'Al', email: 'al@logic.example' }, fields: { 'Seat price': '1' } }] })).data.error, /holds the template's own wording/);
  assert.match((await s.post('/bulk', { template_id: tpl.id, rows: [{ Client: { name: 'Al', email: 'al@logic.example' }, fields: { Colour: 'Red' } }] })).data.error, /The column "Colour" names no field of the template/);
  const bulk = await s.post('/bulk', { template_id: tpl.id, rows: [
    { Client: { name: 'Gina Gold', email: 'gina@logic.example' }, fields: { plan: 'Gold', Seats: '2' } },
    { Client: { name: 'Sid Silver', email: 'sid@logic.example' }, fields: { Plan: 'Silver' } },
  ] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.equal(bulk.data.sent, 2, JSON.stringify(bulk.data));
  const [gold, silver] = bulk.data.results.map((x: any) => x.id);
  pointsHome(gold);
  assert.equal(fieldsOf(gold).Plan.value, 'Gold');
  assert.equal(fieldsOf(gold).Total.value, '40', 'worked out from the row the moment it is made');
  const gina = await opened(gold, 'gina@logic.example');
  assert.equal(gina.v.fields.find((f: any) => f.label === 'Plan').value, 'Gold', 'the signer starts with the row\'s value and can change it');
  assert.match((await gina.c.post(`/sign/${gina.tok}/complete`, { values: { ...gina.marks }, signature_png: PNG })).data.error, /A required field is still empty: Gold extras/);
  const sid = await opened(silver, 'sid@logic.example');
  assert.equal((await sid.c.post(`/sign/${sid.tok}/complete`, { values: { ...sid.marks, [sid.id('Seats')!]: '1' }, signature_png: PNG })).status, 200);
});

test('a template whose wording is locked keeps its rules and formulas: someone who may not change it cannot change them', async () => {
  const owner = await person('Olive Lock', 'olive@logic.example');
  const t = Date.now();
  assert.equal((await owner.post('/account/invites', { email: `mo.${t}@logic.example`, role: 'member' })).status, 200);
  const mo = Object.assign(new Client(), { ip: '10.79.0.2' });
  const token = db.get('SELECT token FROM invites WHERE email=? AND accepted_at IS NULL', `mo.${t}@logic.example`).token;
  assert.equal((await mo.post('/auth/signup', { name: 'Mo Member', email: `mo.${t}@logic.example`, password: 'correct horse battery', invite: token })).status, 200);
  const tpl = await planTemplate(owner);
  assert.equal((await owner.put(`/envelopes/${tpl.id}/access`, { locked: true })).status, 200);
  const made = await mo.post('/envelopes', { template_id: tpl.id, recipients: { Client: { name: 'Cleo', email: 'cleo@logic.example' } } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const e = (await mo.get(`/envelopes/${made.data.envelope.id}`)).data.envelope;
  const body = { fields: e.fields.map((f: any) => (f.label === 'Gold extras' ? { ...f, show_when: null } : f)) };
  const r = await mo.put(`/envelopes/${e.id}`, body);
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.data.error, /Field \d+ \("Gold extras"\) cannot be moved, resized or changed/);
  const f2 = await mo.put(`/envelopes/${e.id}`, { fields: e.fields.map((f: any) => (f.label === 'Total' ? { ...f, formula: '{Seats} * 1' } : f)) });
  assert.equal(f2.status, 403);
  assert.equal((await mo.put(`/envelopes/${e.id}`, { fields: e.fields })).status, 200, 'sent back as it is, it saves');
});

// ---- The editor and the signing page --------------------------------------------------------------------------

test('the editor predicts the sign-again choice for a changed rule or formula, as the server decides it', async () => {
  const { signsAgain } = await import('../src/components/editor/changes.ts');
  const base: any = {
    documents: [{ id: 'd', file_id: 'f' }],
    recipients: [{ id: 'r1', name: 'Ann', email: 'ann@x.example', role: 'signer', status: 'completed' }, { id: 'r2', name: 'Bob', email: 'bob@x.example', role: 'signer', status: 'sent' }],
    fields: [
      { id: 'box', document_id: 'd', recipient_id: 'r2', type: 'checkbox', page: 0, x: 0.1, y: 0.1, w: 0.03, h: 0.02 },
      { id: 'txt', document_id: 'd', recipient_id: 'r2', type: 'text', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03, show_when: { field: 'box', is: 'checked' } },
      { id: 'n', document_id: 'd', recipient_id: 'r2', type: 'number', page: 0, x: 0.1, y: 0.3, w: 0.2, h: 0.03 },
      { id: 't', document_id: 'd', recipient_id: 'r2', type: 'number', page: 0, x: 0.5, y: 0.3, w: 0.2, h: 0.03, formula: '{n} * 2' },
    ],
  };
  const edit = (fid: string, p: any) => ({ ...base, fields: base.fields.map((f: any) => (f.id === fid ? { ...f, ...p } : f)) });
  assert.deepEqual(signsAgain(base, base).map((r: any) => r.name), []);
  assert.deepEqual(signsAgain(base, edit('txt', { show_when: { field: 'box', is: 'unchecked' } })).map((r: any) => r.name), ['Ann']);
  assert.deepEqual(signsAgain(base, edit('txt', { show_when: null })).map((r: any) => r.name), ['Ann']);
  assert.deepEqual(signsAgain(base, edit('t', { formula: '{n} * 3' })).map((r: any) => r.name), ['Ann']);
  assert.deepEqual(signsAgain(base, edit('txt', { show_when: JSON.stringify({ field: 'box', is: 'checked' }) })).map((r: any) => r.name), [], 'the same rule written as stored is no change');
});

test('the signing page shows, hides and works out live, with other people\'s answers counted as the server counts them', async () => {
  const { liveLogic, calcNote } = await import('../src/components/sign/logic.ts');
  const mine = [
    { id: 'co', type: 'checkbox', label: 'Has a co-signer', recipient_id: 'me' },
    { id: 'name', type: 'text', label: 'Co-signer name', required: 1, recipient_id: 'me', show_when: { field: 'co', is: 'checked' } },
    { id: 'q', type: 'number', label: 'Quantity', recipient_id: 'me' },
    { id: 'p', type: 'number', label: 'Unit price', readonly: 1, value: '12,50', recipient_id: 'me' },
    { id: 't', type: 'number', label: 'Total', required: 1, recipient_id: 'me', formula: 'round({q} * {p} + {fee} + {later}, 2)' },
  ];
  const others = [
    { id: 'fee', type: 'number', label: 'Fee', value: '5', from: 'sender' },
    { id: 'later', type: 'number', label: 'Their extra', value: '100', from: 'start' },
  ];
  let live = liveLogic(mine, others, { co: '', q: '2' });
  assert.deepEqual(live.fields.map((f: any) => f.id), ['co', 'q', 'p', 't'], 'the co-signer name is not on the screen');
  const t = live.fields.find((f: any) => f.id === 't');
  assert.equal(t.readonly, 1, 'nobody types in a calculated field');
  assert.equal(t.required, 0);
  assert.equal(t.value, '30,00', "the sender's fee counts; someone else's unfinished answer does not");
  assert.match(t.calc_note, /^Worked out for you from 'Quantity' × 'Unit price' \+ 'Fee' \+ 'Their extra', rounded to 2 decimals\. With Quantity 2, Unit price 12,5, Fee 5, Their extra 0, that comes to 30,00\. Empty fields count as 0\.$/);
  live = liveLogic(mine, others, { co: '1', q: '' });
  assert.ok(live.fields.some((f: any) => f.id === 'name'));
  assert.equal(live.fields.find((f: any) => f.id === 't').value, '5,00');
  assert.match(calcNote({ formula: '{a} / {b}' }, { value: null, text: null, error: 'This cannot be worked out yet: it would divide by 0, because \'B\' is 0 or empty.', empty: false, ambiguous: [], numbers: '' }, (id) => id.toUpperCase()), /Worked out for you from 'A' ÷ 'B'\. This cannot be worked out yet: it would divide by 0/);
  assert.match(calcNote({ formula: '{a}' }, { value: null, text: null, error: null, empty: true, ambiguous: [], numbers: '' }, (id) => id), /Fills in by itself once the fields it is worked out from are filled in/);
});

test('a bulk list: a column named like a field fills it for that row, and nothing else is taken', async () => {
  const { readFieldColumns, fillableColumns } = await import('../src/components/sender/fieldColumns.ts');
  const { readRecipients } = await import('../src/components/sender/csv.ts');
  const fields = [
    { id: 'p', type: 'dropdown', label: 'Plan', options: ['Gold', 'Silver'] },
    { id: 's', type: 'number', label: 'Seats' },
    { id: 't', type: 'number', label: 'Total', formula: '{s} * 2' },
    { id: 'fee', type: 'text', label: 'Fee', readonly: 1, value: 'USD 500' },
    { id: 'a', type: 'radio', label: 'Monthly', group_name: 'Billing' }, { id: 'b', type: 'radio', label: 'Yearly', group_name: 'Billing' },
    { id: 'sig', type: 'signature', label: 'Sign' },
  ];
  assert.deepEqual([...fillableColumns(fields).values()], ['Plan', 'Seats', 'Billing'], 'not the total, the fixed fee or the signature');
  const csv = 'Client name,Client email,plan,SEATS,Total,Notes,Billing\nAda,ada@x.example,Gold,3,999,hi,Yearly\nBen,ben@x.example,,,,,\n';
  const reading = readRecipients(csv, [{ key: 'Client', label: 'Client' }]);
  const cols = readFieldColumns(csv, fields, reading.header);
  assert.deepEqual(cols.names, ['plan', 'SEATS', 'Billing']);
  assert.deepEqual(cols.byRow.get(reading.rows[0].row), { Plan: 'Gold', Seats: '3', Billing: 'Yearly' });
  assert.equal(cols.byRow.get(reading.rows[1].row), undefined, 'empty cells fill nothing');
  assert.deepEqual(readFieldColumns('Ada,ada@x.example,Gold', fields, false).names, [], 'without a header row no column can name a field');
});

// ---- Abuse, and honest people who would otherwise get stuck ---------------------------------------------------

test('a phone number hidden in a formula is read by the filter for fake payment notices, like any other words the signer sees', async () => {
  const s = await person('Fay Formula', 'fay@logic.example');
  const file = await upload(s, 1);
  const make = (formula: string) => s.post('/envelopes', {
    subject: 'Your PayPal invoice', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', name: 'Vic Victim', email: 'vic.f@logic.example' }],
    fields: [
      { id: 'q', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Refund of $499.00', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.03 },
      { id: 't', document_id: 'd', recipient_id: 'r', type: 'number', label: 'Total', formula, page: 0, x: 0.1, y: 0.2, w: 0.2, h: 0.03 },
      { id: 's', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.6, w: 0.3, h: 0.06 },
    ],
  });
  const plain = (await make('{q} * 2')).data.envelope;
  assert.equal((await s.post(`/envelopes/${plain.id}/send`)).status, 200, 'brand and money alone are not a lure');
  const lure = (await make('{q} + 18885550142')).data.envelope;
  const r = await s.post(`/envelopes/${lure.id}/send`);
  assert.equal(r.status, 422, JSON.stringify(r.data));
});

test('deleting a field others depend on puts them right in the same step, and the server names a missing field as people know it', async () => {
  const { dropField } = await import('../src/lib/logic.ts');
  const withoutField = (l: any[], id: string) => dropField(l, id, (f: any) => f.label);
  {
    const list = [
      { id: 'box', type: 'checkbox', label: 'Has a co-signer' },
      { id: 'name', type: 'text', label: 'Co-signer name', show_when: { field: 'box', is: 'checked' } },
      { id: 'q', type: 'number', label: 'Quantity' },
      { id: 't', type: 'number', label: 'Total', formula: '{q} * 2 + {q}' },
    ];
    let r = withoutField(list, 'box');
    assert.equal(r.list.find((f: any) => f.id === 'name').show_when, null);
    assert.equal(r.said.join(' '), 'Has a co-signer was deleted. Co-signer name depended on it and is now always shown. Undo brings it back.');
    r = withoutField(list, 'q');
    assert.equal(r.list.find((f: any) => f.id === 't').formula, '0 * 2 + 0');
    assert.match(r.said.join(' '), /The formula of Total used it and counts 0 in its place now/);
    assert.deepEqual(withoutField(list, 'name').said, [], 'nothing depended on it, nothing to say');
  }
  const s = await person('Gus Gone', 'gus@logic.example');
  const e = await quote(s, 'ada9@logic.example');
  const got = (await s.get(`/envelopes/${e.id}`)).data.envelope;
  const r = await s.put(`/envelopes/${e.id}`, { fields: got.fields.filter((f: any) => f.label !== 'Has a co-signer') });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Field \d+ \("Co-signer name"\) is shown when 'Has a co-signer', and that field is no longer on the envelope\. Choose another field, or take the rule out\. Nothing was saved\./);
});

test('the review step says when every signature of a person depends on an answer', () => {
  const said = logicWarnings([
    { id: 'box', type: 'checkbox', recipient_id: 'r', label: 'Company' },
    { id: 's', type: 'signature', recipient_id: 'r', show_when: { field: 'box', is: 'checked' } },
  ] as any, [{ id: 'r', name: 'Ada', role: 'signer' }], false, (f: any) => f.label || f.type).join(' ');
  assert.match(said, /Every signature and initials field of Ada is shown only after a certain answer\. With other answers Ada finishes without signing anywhere on the page/);
});

test('two fields that are never shown at the same time may share a place on the page', async () => {
  const { stackedFields } = await import('../src/lib/stacked.ts');
  const box = { id: 'box', type: 'checkbox', recipient_id: 'r', document_id: 'd', page: 0, x: 0.1, y: 0.1, w: 0.03, h: 0.02 };
  const at = { recipient_id: 'r', document_id: 'd', page: 0, x: 0.3, y: 0.3, w: 0.3, h: 0.03, type: 'text' };
  const people = [{ id: 'r', name: 'Ada' }], docs = [{ id: 'd', name: 'Doc' }];
  const both = (a: any, b: any) => stackedFields([box, { ...at, id: 'a', show_when: a }, { ...at, id: 'b', show_when: b }] as any, people, docs);
  assert.deepEqual(both({ field: 'box', is: 'checked' }, { field: 'box', is: 'unchecked' }), [], 'ticked and not ticked');
  assert.deepEqual(both({ field: 'p', is: 'equals', value: 'Gold' }, { field: 'p', is: 'equals', value: 'silver' }), []);
  assert.deepEqual(both({ field: 'p', is: 'equals', value: 'Gold' }, { field: 'p', is: 'not_equals', value: 'gold' }), []);
  assert.equal(both({ field: 'box', is: 'checked' }, { field: 'box', is: 'checked' }).length, 1, 'both can be shown at once: refused as before');
  assert.equal(both({ field: 'box', is: 'checked' }, null).length, 1);
  assert.equal(both({ field: 'p', is: 'equals', value: 'Gold' }, { field: 'q', is: 'equals', value: 'Silver' }).length, 1, 'different fields can both be answered');
});

test('on the signing page a field that appears or goes is said once, its answer is cleared, and loading the page says nothing', async () => {
  const { fieldChange, liveLogic } = await import('../src/components/sign/logic.ts');
  const mine = [
    { id: 'co', type: 'checkbox', label: 'Has a co-signer' },
    { id: 'name', type: 'text', label: 'Co-signer name', required: 1, show_when: { field: 'co', is: 'checked' } },
    { id: 'note', type: 'text', label: 'Note for the co-signer', prefill: 'Welcome', show_when: { field: 'co', is: 'checked' } },
  ];
  const hidden = (values: any) => liveLogic(mine, [], values).hidden;
  const first = fieldChange(mine, null, hidden({ co: '' }), { co: '', name: 'Old answer' });
  assert.equal(first.said, '', 'the first look announces nothing');
  assert.deepEqual(first.clear, { name: '', note: 'Welcome' }, "a hidden answer goes, the sender's own words come back");
  const ticked = fieldChange(mine, first.shown, hidden({ co: '1' }), { co: '1' });
  assert.equal(ticked.said, 'A field appeared: Co-signer name, required; Note for the co-signer, optional. Next goes there.'.replace('A field appeared', '2 fields appeared'));
  assert.equal(ticked.came, 'name', 'Next goes to the required one');
  const unticked = fieldChange(mine, ticked.shown, hidden({ co: '' }), { co: '', name: 'Bob', note: 'Welcome' });
  assert.equal(unticked.said, '2 fields are no longer needed: Co-signer name, Note for the co-signer. What was in it was cleared.');
  assert.deepEqual(unticked.clear, { name: '' });
  assert.equal(unticked.came, null);
});

// ---- Repairs after the skeptic's report (research/verify-new.json, "verify:logic") ------------------------------

// Page 1 of a PDF: how many pictures are drawn on it (signatures and initials), and its words.
async function pageOne(pdf: Uint8Array): Promise<{ images: number; text: string }> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const page = await doc.getPage(1);
    const images = (await page.getOperatorList()).fnArray.filter((fn: number) => fn === pdfjs.OPS.paintImageXObject).length;
    return { images, text: (await page.getTextContent()).items.map((x: any) => x.str).join(' ') };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
const at = (y: number, extra: any) => ({ document_id: 'd', page: 0, x: 0.1, y, w: 0.25, h: 0.04, ...extra });

test('a calculated result with three decimals stays that number: on the PDF, in the sender\'s counts and in the next person\'s formula', async () => {
  // Owner's decision: a stored calculated value reads back as the same number in every notation.
  const { canonOf } = await import('../src/lib/logic.ts');
  const r1 = calc('{q} * {p}', { q: '3', p: '0.411' });
  assert.deepEqual([r1.text, r1.canon, r1.value], ['1.233', '1.233', 1.233]);
  const r2 = calc('{q} * {p}', { q: '1,5', p: '0,822' });
  assert.deepEqual([r2.text, r2.canon], ['1,233', '1.233'], 'shown with a comma, kept plainly');
  assert.equal(calc('round({q}, 3)', { q: '2.4689' }).canon, '2.469');
  assert.equal(canonOf({ value: '1,233', calc_num: '1.233' }), 1.233);
  assert.equal(canonOf({ value: null, calc_num: '1.233' }), null, 'a view that blanks the value blanks its number');
  // Read back as stored, by the next formula and by a rule, in both notations, also the comma kept for the result.
  for (const [text, num, want] of [['1.233', '1.233', '2.466'], ['1,233', '1.233', '2,466']]) {
    const o = workOut([
      F('t', 'number', { recipient_id: 'ann', formula: '{a} * {b}', value: text, calc_num: num }),
      F('g', 'number', { recipient_id: 'ben', formula: '{t} * 2' }),
      F('small', 'text', { recipient_id: 'ben', show_when: { field: 'g', is: 'less_than', value: '1000' } }),
    ], { stored: (f) => f.recipient_id === 'ann' });
    assert.equal(o.calc.get('g')!.text, want, `${text} is read as ${num}`);
    assert.ok(!o.hidden.has('small'));
  }
  const mixed = evaluate(parseFormula('{t} * {d}'), (id) => (id === 't' ? { num: 1.233, text: '1,233' } : { text: '1.234' }), (id) => id);
  assert.equal(mixed.value, 1521.522, 'the comma of a calculated input says how a lone 1.234 typed next to it is meant');
  assert.equal(mixed.text, '1521,522');

  const s = await person('Fern Fuel', 'fern@logic.example');
  const file = await upload(s, 1);
  const e = (await s.post('/envelopes', {
    subject: 'Fuel order', documents: [{ id: 'd', file_id: file.id }], ordered: true,
    recipients: [{ id: 'bea', name: 'Bea Buyer', email: 'bea@logic.example', routing_order: 1 }, { id: 'ben', name: 'Ben Booker', email: 'ben.b@logic.example', routing_order: 2 }],
    fields: [
      at(0.05, { id: 'l', recipient_id: 'bea', type: 'number', label: 'Litres' }),
      at(0.12, { id: 'p', recipient_id: 'bea', type: 'number', label: 'Price per litre', readonly: true, value: '0.411' }),
      at(0.19, { id: 't', recipient_id: 'bea', type: 'number', label: 'Total', formula: '{Litres} * {Price per litre}' }),
      at(0.26, { id: 's', recipient_id: 'bea', type: 'signature', label: 'Sign for a small order', show_when: { field: 't', is: 'less_than', value: '1000' } }),
      at(0.33, { id: 'f', recipient_id: 'bea', type: 'text', label: 'Freight terms', readonly: true, value: 'FREIGHT SURCHARGE 250 APPLIES', show_when: { field: 't', is: 'more_than', value: '1000' } }),
      at(0.45, { id: 'n', recipient_id: 'ben', type: 'number', label: 'Deliveries' }),
      at(0.52, { id: 'g', recipient_id: 'ben', type: 'number', label: 'Grand total', formula: '{Total} * {Deliveries}' }),
      at(0.62, { id: 'bs', recipient_id: 'ben', type: 'signature', label: 'Ben signs' }),
    ],
  })).data.envelope;
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const bea = await opened(e.id, 'bea@logic.example');
  assert.equal((await bea.c.post(`/sign/${bea.tok}/complete`, { values: { ...bea.marks, [bea.id('Litres')!]: '3' }, signature_png: PNG })).status, 200);
  assert.deepEqual([fieldsOf(e.id).Total.value, fieldsOf(e.id).Total.calc_num], ['1.233', '1.233']);
  const progress = (await s.get(`/envelopes/${e.id}`)).data.envelope.recipients.find((r: any) => r.name === 'Bea Buyer').progress;
  assert.equal(progress.required_left, 0, 'the signature she gave is counted as shown, not as hidden by a total of 1233');
  // The sender saves the envelope again unchanged: the kept result keeps its number.
  const now = (await s.get(`/envelopes/${e.id}`)).data.envelope;
  assert.equal(now.fields.find((f: any) => f.label === 'Total').calc_num, '1.233', 'the API gives the number too');
  // A number sent along for it is not taken: it is the server's, and what Bea signed stays.
  assert.equal((await s.put(`/envelopes/${e.id}`, { fields: now.fields.map((f: any) => (f.label === 'Total' ? { ...f, calc_num: '999' } : f)) })).status, 200);
  assert.equal(fieldsOf(e.id).Total.calc_num, '1.233');
  // Ben's screen is given Bea's total with its number, and works his out the way the server stores it.
  const ben = await opened(e.id, 'ben.b@logic.example');
  const input = ben.v.formula_inputs.find((x: any) => x.label === 'Total');
  assert.deepEqual([input.value, input.num, input.pending], ['1.233', 1.233, false]);
  assert.equal(ben.v.others.find((x: any) => x.label === 'Total').num, 1.233, 'the fields drawn on his page carry the number too');
  const { liveLogic } = await import('../src/components/sign/logic.ts');
  const live = liveLogic(ben.v.fields, ben.v.formula_inputs, { [ben.id('Deliveries')!]: '2' });
  assert.equal(live.fields.find((f: any) => f.label === 'Grand total').value, '2.466');
  assert.equal((await ben.c.post(`/sign/${ben.tok}/complete`, { values: { ...ben.marks, [ben.id('Deliveries')!]: '2' }, inputs: ben.v.inputs, signature_png: PNG })).status, 200);
  assert.equal(fieldsOf(e.id)['Grand total'].value, '2.466', 'not 2466');
  const look = await pageOne((await s.get(`/envelopes/${e.id}/download`)).data);
  assert.equal(look.images, 2, "Bea's and Ben's signatures are both printed");
  assert.match(look.text, /1\.233/);
  assert.match(look.text, /2\.466/);
  assert.doesNotMatch(look.text, /FREIGHT SURCHARGE/, 'the wording that was hidden when Bea signed is not printed');
});

test('nobody finishes as signed without a picture: what is shown at Finish is worked out once, from what is stored', async () => {
  // Owner's decision: the same result decides what is required and what is printed.
  const s = await person('Ari Attach', 'ari@logic.example');
  const file = await upload(s, 1);
  const e = (await s.post('/envelopes', {
    documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', name: 'Mal Signer', email: 'mal@logic.example' }],
    fields: [
      at(0.1, { id: 'proof', recipient_id: 'r', type: 'attachment', label: 'Signed paper copy', required: false }),
      at(0.7, { id: 'sig', recipient_id: 'r', type: 'signature', label: 'Sign here', show_when: { field: 'proof', is: 'empty' } }),
    ],
  })).data.envelope;
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const m = await opened(e.id, 'mal@logic.example');
  // A file id that does not exist is not kept, so the signature stays on the page and needs a picture.
  let r = await m.c.post(`/sign/${m.tok}/complete`, { values: { [m.id('Signed paper copy')!]: 'file_doesnotexist', [m.id('Sign here')!]: '1' } });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error, /Your signature is missing\. Make it on the page, then finish again\./);
  assert.equal(db.get("SELECT status FROM recipients WHERE email='mal@logic.example'").status, 'viewed', 'nothing was signed, the claim was undone');
  assert.equal(db.all("SELECT 1 FROM audit WHERE envelope_id=? AND action='Signed'", e.id).length, 0);
  r = await m.c.post(`/sign/${m.tok}/complete`, { values: { [m.id('Signed paper copy')!]: 'file_doesnotexist', [m.id('Sign here')!]: '1' }, signature_png: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await pageOne((await s.get(`/envelopes/${e.id}/download`)).data)).images, 1, 'and the picture is printed');

  // Someone else's saved, unfinished answer does not count either way.
  const s2 = await person('Bo Both', 'bo@logic.example');
  const file2 = await upload(s2, 1);
  const e2 = (await s2.post('/envelopes', {
    documents: [{ id: 'd', file_id: file2.id }],
    recipients: [{ id: 'a', name: 'Al Buyer', email: 'al.b@logic.example' }, { id: 'b', name: 'Bi Seller', email: 'bi.s@logic.example' }],
    fields: [
      at(0.1, { id: 'q', recipient_id: 'a', type: 'number', label: 'Quantity' }),
      at(0.2, { id: 't', recipient_id: 'a', type: 'number', label: 'Total', formula: '{Quantity} * {Price}' }),
      at(0.7, { id: 'sa', recipient_id: 'a', type: 'signature', label: 'Buyer signs (under 1000)', show_when: { field: 't', is: 'less_than', value: '1000' } }),
      at(0.3, { id: 'p', recipient_id: 'b', type: 'number', label: 'Price' }),
      at(0.85, { id: 'sb', recipient_id: 'b', type: 'signature' }),
    ],
  })).data.envelope;
  assert.equal((await s2.post(`/envelopes/${e2.id}/send`)).status, 200);
  const bi = await opened(e2.id, 'bi.s@logic.example');
  assert.equal((await bi.c.post(`/sign/${bi.tok}/save`, { values: { [bi.id('Price')!]: '437' } })).status, 200);
  const al = await opened(e2.id, 'al.b@logic.example');
  assert.deepEqual(al.v.formula_inputs.map((x: any) => [x.label, x.value, x.pending, x.by]), [['Price', null, true, 'Bi Seller']], "Bi's saved price is not given to Al's screen");
  // Every quantity answers the same, so nothing about Bi's price can be learned from the answers.
  const said = new Set<string>();
  for (const q of ['1', '2', '3', '50', '1000']) {
    r = await al.c.post(`/sign/${al.tok}/complete`, { values: { [al.id('Quantity')!]: q, [al.id('Buyer signs (under 1000)')!]: '1' } });
    said.add(`${r.status} ${r.data.error}`);
  }
  assert.deepEqual([...said], ['400 Your signature is missing. Make it on the page, then finish again.']);
  // Bi changing an unfinished answer changes nothing Al counts, so Al's screen is not sent back to look again.
  assert.equal((await bi.c.post(`/sign/${bi.tok}/save`, { values: { [bi.id('Price')!]: '999' } })).status, 200);
  r = await al.c.post(`/sign/${al.tok}/complete`, { values: { [al.id('Quantity')!]: '3', [al.id('Buyer signs (under 1000)')!]: '1' }, inputs: al.v.inputs, signature_png: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.get("SELECT signature_png FROM recipients WHERE email='al.b@logic.example'").signature_png, PNG);
});

test('when someone else finishes while a screen is open, the total that screen shows is not signed: Finish says so and the page shows the new one', async () => {
  const s = await person('Tia Timesheet', 'tia@logic.example');
  const file = await upload(s, 1);
  const e = (await s.post('/envelopes', {
    documents: [{ id: 'd', file_id: file.id }],
    recipients: [{ id: 'u', name: 'Una Worker', email: 'una.w@logic.example' }, { id: 'v', name: 'Vic Client', email: 'vic.c@logic.example' }],
    fields: [
      at(0.1, { id: 'h', recipient_id: 'u', type: 'number', label: 'Hours' }),
      at(0.2, { id: 'rate', recipient_id: 'v', type: 'number', label: 'Rate' }),
      at(0.3, { id: 'due', recipient_id: 'v', type: 'number', label: 'Amount due', formula: '{Hours} * {Rate}' }),
      at(0.4, { id: 'ok', recipient_id: 'v', type: 'text', label: 'Approval reference for amounts over 1000', show_when: { field: 'due', is: 'more_than', value: '1000' } }),
      at(0.7, { id: 'us', recipient_id: 'u', type: 'signature' }),
      at(0.8, { id: 'vs', recipient_id: 'v', type: 'signature' }),
    ],
  })).data.envelope;
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const { liveLogic } = await import('../src/components/sign/logic.ts');
  const vic = await opened(e.id, 'vic.c@logic.example');
  const rate = vic.id('Rate')!;
  let live = liveLogic(vic.v.fields, vic.v.formula_inputs, { [rate]: '50' });
  const due = live.fields.find((f: any) => f.label === 'Amount due');
  assert.equal(due.value, '0');
  // The note names every field by its label, and says whose answer it waits for. Never an id.
  assert.equal(due.calc_note, "Worked out for you from 'Hours' × 'Rate'. With Hours 0, Rate 50, that comes to 0. Empty fields count as 0. 'Hours' counts once Una Worker has finished.");
  assert.ok(!live.fields.some((f: any) => /Approval/.test(f.label)));
  const una = await opened(e.id, 'una.w@logic.example');
  assert.equal((await una.c.post(`/sign/${una.tok}/complete`, { values: { ...una.marks, [una.id('Hours')!]: '40' }, inputs: una.v.inputs, signature_png: PNG })).status, 200);
  // A page that sends no key (loaded before keys were given) is held to the one the server last gave it.
  let r = await vic.c.post(`/sign/${vic.tok}/complete`, { values: { ...vic.marks, [rate]: '50' }, signature_png: PNG });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  // Vic presses Finish on the screen he opened before: nothing is signed, and he is told why in words.
  r = await vic.c.post(`/sign/${vic.tok}/complete`, { values: { ...vic.marks, [rate]: '50' }, inputs: vic.v.inputs, version: vic.v.version, signature_png: PNG });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, 'changed', 'the page loads the document again, as for any change');
  assert.equal(r.data.why, 'inputs');
  assert.equal(r.data.error, "Una Worker finished while you had this document open, and what they filled in counts in 'Amount due'. Nothing was signed. It is worked out again below with their answers: look at it before you finish.");
  assert.equal(db.get("SELECT status FROM recipients WHERE email='vic.c@logic.example'").status, 'viewed');
  // Loaded again, the page works out what the server will store, and the field that comes with it appears.
  const again = (await vic.c.get(`/sign/${vic.tok}`)).data;
  assert.notEqual(again.inputs, vic.v.inputs);
  live = liveLogic(again.fields, again.formula_inputs, { [rate]: '50' });
  assert.equal(live.fields.find((f: any) => f.label === 'Amount due').value, '2000');
  const okId = live.fields.find((f: any) => /Approval/.test(f.label))?.id;
  assert.ok(okId, 'the approval reference is on the screen now');
  r = await vic.c.post(`/sign/${vic.tok}/complete`, { values: { ...vic.marks, [rate]: '50', [okId]: 'PO-77' }, inputs: again.inputs, version: again.version, signature_png: PNG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fieldsOf(e.id)['Amount due'].value, '2000', 'what he was shown is what is stored and printed');
  // A caller that was never given a key (no screen) is not held to one, and a screen with no formulas has none.
  assert.equal(una.v.inputs, null);
});

test('a number answer written two ways is one answer, so two fields that depend on it may not share a place', async () => {
  const { stackedFields } = await import('../src/lib/stacked.ts');
  const qty = { id: 'q', type: 'number', recipient_id: 'r', document_id: 'd', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.03 };
  const word = { id: 'w', type: 'text', recipient_id: 'r', document_id: 'd', page: 0, x: 0.1, y: 0.5, w: 0.2, h: 0.03 };
  const spot = { recipient_id: 'r', document_id: 'd', page: 0, x: 0.3, y: 0.3, w: 0.3, h: 0.03, type: 'text' };
  const both = (a: any, b: any) => stackedFields([qty, word, { ...spot, id: 'a', show_when: a }, { ...spot, id: 'b', show_when: b }] as any, [{ id: 'r', name: 'Ada' }], [{ id: 'd', name: 'Doc' }]);
  assert.equal(both({ field: 'q', is: 'equals', value: '1.000' }, { field: 'q', is: 'equals', value: '1000' }).length, 1, 'a quantity of 1000 shows both');
  assert.equal(both({ field: 'q', is: 'equals', value: '5' }, { field: 'q', is: 'equals', value: '5.0' }).length, 1);
  assert.deepEqual(both({ field: 'q', is: 'equals', value: '5' }, { field: 'q', is: 'equals', value: '6' }), []);
  assert.deepEqual(both({ field: 'q', is: 'equals', value: '1.000' }, { field: 'q', is: 'not_equals', value: '1000' }), [], 'equal and not equal to the same number');
  assert.deepEqual(both({ field: 'w', is: 'equals', value: '5' }, { field: 'w', is: 'equals', value: '5.0' }), [], 'for words, 5 and 5.0 are two answers');
});

test('two radio buttons of one group cannot both be chosen, and choosing one takes the other off', async () => {
  const s = await person('Rae Radio', 'rae@logic.example');
  const file = await upload(s, 1);
  const e = (await s.post('/envelopes', {
    documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', name: 'Ro Reader', email: 'ro@logic.example' }],
    fields: [
      at(0.1, { id: 'a', recipient_id: 'r', type: 'radio', label: 'Monthly', group_name: 'Billing', required: false, w: 0.03, h: 0.02 }),
      at(0.15, { id: 'b', recipient_id: 'r', type: 'radio', label: 'Yearly', group_name: 'Billing', required: false, w: 0.03, h: 0.02 }),
      at(0.3, { id: 'yt', recipient_id: 'r', type: 'text', label: 'Yearly terms', show_when: { field: 'b', is: 'checked' } }),
      at(0.4, { id: 'mt', recipient_id: 'r', type: 'text', label: 'Monthly terms', show_when: { field: 'a', is: 'checked' } }),
      at(0.8, { id: 'sig', recipient_id: 'r', type: 'signature' }),
    ],
  })).data.envelope;
  assert.equal((await s.post(`/envelopes/${e.id}/send`)).status, 200);
  const ro = await opened(e.id, 'ro@logic.example');
  const both = { [ro.id('Monthly')!]: '1', [ro.id('Yearly')!]: '1', [ro.id('Monthly terms')!]: 'M', [ro.id('Yearly terms')!]: 'Y' };
  let r = await ro.c.post(`/sign/${ro.tok}/complete`, { values: { ...ro.marks, ...both }, signature_png: PNG });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'Only one option can be chosen for Billing, and 2 were chosen: Monthly, Yearly. Choose one and try again. Nothing was saved.');
  assert.equal((await ro.c.post(`/sign/${ro.tok}/save`, { values: both })).status, 400, 'a save is refused the same way');
  assert.equal((await ro.c.post(`/sign/${ro.tok}/save`, { values: { [ro.id('Monthly')!]: '1', [ro.id('Monthly terms')!]: 'M' } })).status, 200);
  // A later save names only Yearly: Monthly goes off, and so do its terms.
  assert.equal((await ro.c.post(`/sign/${ro.tok}/save`, { values: { [ro.id('Yearly')!]: '1', [ro.id('Yearly terms')!]: 'Y' } })).status, 200);
  const f = fieldsOf(e.id);
  assert.deepEqual([f.Monthly.value, f.Yearly.value, f['Monthly terms'].value, f['Yearly terms'].value], [null, '1', null, 'Y']);
});

test('a very long line of fields that depend on each other is refused in words, and never runs the stack out', async () => {
  const { longestChain, MAX_CHAIN } = await import('../src/lib/logic.ts');
  const line = (n: number) => Array.from({ length: n }, (_, i) => F(`n${i}`, 'number', { label: `N${i}`, formula: i < n - 1 ? `{n${i + 1}} + 1` : null }));
  assert.deepEqual(longestChain(line(5000)), { id: 'n0', length: 5000 });
  assert.deepEqual(loopsIn(line(5000)), [], 'walked without calling itself');
  const legacy = workOut(line(3000));
  assert.match(legacy.calc.get('n0')!.error!, /cannot be worked out/, 'saved before the limit: not worked out, and no crash');
  const s = await person('Cha Chain', 'cha@logic.example');
  const file = await upload(s, 1);
  const make = (n: number) => s.post('/envelopes', {
    documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', name: 'Rae', email: `rae${n}@logic.example` }],
    fields: [...line(n).map((f: any, i: number) => ({ ...f, recipient_id: 'r', document_id: 'd', page: 0, x: (i % 40) / 41, y: Math.floor(i / 40) / (n / 40 + 2), w: 0.006, h: 0.006, required: false })),
      { id: 'sig', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.5, y: 0.95, w: 0.2, h: 0.04 }],
  });
  let r = await make(1500);
  assert.equal(r.status, 400, JSON.stringify(r.data).slice(0, 300));
  assert.equal(r.data.code, 'logic_chain');
  assert.match(r.data.error, /^'N0' depends on a line of 1499 other fields/);
  assert.match(r.data.error, /depends on a line of 1499 other fields.*at most 100 fields can depend on each other in one line.*sum\(\{Line 1\}, \{Line 2\}\)\. Nothing was saved\.$/);
  r = await make(MAX_CHAIN);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
});

test('numbers too long for a formula, a result that rounds up past the limit, digits of every script, and a rule value with a space', async () => {
  assert.match(refused('12345678901234567 - 12345678901234566'), /The number 12345678901234567 in the formula has more than 15 digits/);
  assert.match(refused(`${'9'.repeat(450)} + 1`), /The number 9{20}\.\.\. in the formula has more than 15 digits/);
  assert.equal(calc('{a} * 0.000000001', { a: '1' }).text, '0.000000001', 'a short number with many zeros is fine');
  assert.match(calc('{a} + 0.5', { a: '999999999999999' }).error!, /too large to work out exactly/, '999999999999999.5 shows as 1000000000000000');
  assert.deepEqual(['𝟙𝟘𝟘', '𝟏𝟎𝟎', '𝟸𝟹', '１２３', '١٢٣', '१२३', '٣٫٥'].map((t) => readNumber(t)?.value), [100, 100, 23, 123, 123, 123, 3.5]);
  const { signsAgain } = await import('../src/components/editor/changes.ts');
  const base: any = {
    documents: [{ id: 'd', file_id: 'f' }],
    recipients: [{ id: 'r1', name: 'Ann', email: 'ann@x.example', role: 'signer', status: 'completed' }, { id: 'r2', name: 'Bob', email: 'bob@x.example', role: 'signer', status: 'sent' }],
    fields: [
      { id: 'plan', document_id: 'd', recipient_id: 'r2', type: 'dropdown', options: ['Gold'], page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.03 },
      { id: 'txt', document_id: 'd', recipient_id: 'r2', type: 'text', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03, show_when: { field: 'plan', is: 'equals', value: 'Gold' } },
    ],
  };
  const edited = { ...base, fields: base.fields.map((f: any) => (f.id === 'txt' ? { ...f, show_when: { ...f.show_when, value: 'Gold ' } } : f)) };
  assert.deepEqual(signsAgain(base, edited).map((r: any) => r.name), [], 'the server keeps "Gold", so nobody is asked to sign again');
});
