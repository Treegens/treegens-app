// "Place fields for me" on documents that have no tags, no underscores and no form fields: a signature table with
// one column per person, and bare labels such as "Signature:" with empty space next to them. Also who each place is
// for: a name printed over a column or a block beats the order of the columns.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { findFields, findInText, assignSigners, namesMatch, standaloneLabel, scanPdf, rulesFrom, overlap, type TextItem, type PageScan, type Rule, type Found } from '../src/lib/autoplace.ts';

const LETTER = { w: 612, h: 792 };
let helv: PDFFont;
before(async () => {
  helv = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
});

// One run of text, measured with the real font. `top` is the baseline, measured from the top of the page.
const t = (str: string, top: number, x = 72, size = 11): TextItem => ({ str, x, y: top, w: helv.widthOfTextAtSize(str, size), h: size });
const page = (items: TextItem[], rules?: Rule[]): PageScan => ({ size: LETTER, items, ...(rules ? { rules } : {}) });
const pts = (f: { x: number; y: number; w: number; h: number }) => ({ x0: f.x * 612, x1: (f.x + f.w) * 612, top: f.y * 792, bottom: (f.y + f.h) * 792 });
const brief = (found: Omit<Found, 'page'>[]) => [...found].sort((a, b) => a.y - b.y || a.x - b.x).map((f) => `${f.type}:${f.signer ?? '-'}`);
/** No field may sit on top of text. */
const clearOfText = (found: Omit<Found, 'page'>[], items: TextItem[]) => {
  for (const f of found) {
    const b = pts(f);
    for (const i of items) assert.ok(!(i.x < b.x1 && i.x + i.w > b.x0 && i.y - 0.8 * i.h < b.bottom && i.y > b.top), `${f.type} field covers "${i.str}"`);
  }
};
/** The borders of a table: every column edge and every row edge, as thin lines. */
const grid = (xs: number[], ys: number[]): Rule[] => [
  ...xs.map((x) => ({ x, y: ys[0], w: 0, h: ys[ys.length - 1] - ys[0] })),
  ...ys.map((y) => ({ x: xs[0], y, w: xs[xs.length - 1] - xs[0], h: 0 })),
];

// The last page of the owner's MOU: a paragraph, then a table of three columns and four rows.
const COLS = [72, 212, 376, 540], ROWS = [300, 324, 372, 396, 420];
const ownerTable = (): TextItem[] => [
  t('IN WITNESS WHEREOF the parties have signed this Memorandum of Understanding on the dates below.', 270, 72, 10),
  t('James Cohen', 316, 217), t('Marc Diamond', 316, 381),
  t('Signature', 340, 77),
  t('Date', 388, 77),
  t('Email for notices', 412, 77), t('jimi@treegens.org', 412, 217),
];

test('the owner\'s signature table: a signature and a date in each column, an email in the one empty email cell', () => {
  for (const [how, scan] of [['from text positions alone', page(ownerTable())], ['with the drawn borders', page(ownerTable(), grid(COLS, ROWS))]] as const) {
    const found = findInText(scan);
    assert.deepEqual(brief(found), ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:2'], how);
    assert.ok(found.every((f) => f.source === 'label'));
    clearOfText(found, scan.items);
    for (const f of found) {
      const b = pts(f), col = f.signer === 1 ? [COLS[1], COLS[2]] : [COLS[2], COLS[3]];
      const row = f.type === 'signature' ? [ROWS[1], ROWS[2]] : f.type === 'date_signed' ? [ROWS[2], ROWS[3]] : [ROWS[3], ROWS[4]];
      assert.ok(b.x0 >= col[0] && b.x1 <= col[1], `${how}: ${f.type} for signer ${f.signer} stays inside its column (${Math.round(b.x0)} to ${Math.round(b.x1)})`);
      assert.ok(b.top >= row[0] - 1 && b.bottom <= row[1] + 1, `${how}: ${f.type} for signer ${f.signer} stays inside its row (${Math.round(b.top)} to ${Math.round(b.bottom)})`);
      assert.ok(b.x1 - b.x0 >= 60 && b.bottom - b.top >= 12, `${how}: ${f.type} is big enough to use`);
    }
    assert.deepEqual(found.find((f) => f.signer === 1)!.who, ['James Cohen']);
    assert.deepEqual(found.find((f) => f.signer === 2)!.who, ['Marc Diamond']);

    // The envelope has "James Cohen" and "jimi cohen". James is matched by name. Nobody is called Marc Diamond, so
    // that column goes to the second signer by order.
    const given = assignSigners(findFields([scan]), ['James Cohen', 'jimi cohen']);
    assert.deepEqual(brief(given), ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:2'], how);
  }
  // With the borders, the signature takes the tall row it was given.
  const tall = findInText(page(ownerTable(), grid(COLS, ROWS))).find((f) => f.type === 'signature')!;
  assert.ok(tall.h * 792 > 30, 'the signature uses the height of its cell');
});

test('a table for three signers, and columns with very little padding between them', () => {
  const items = [
    t('Ana Silva', 200, 170), t('Sam Lee', 200, 300), t('Kim Park', 200, 430),
    t('Signature', 230, 72), t('Print name', 260, 72), t('Title', 290, 72), t('Date', 320, 72),
  ];
  const found = findInText(page(items));
  assert.deepEqual(brief(found), ['signature:1', 'signature:2', 'signature:3', 'full_name:1', 'full_name:2', 'full_name:3', 'title:1', 'title:2', 'title:3', 'date_signed:1', 'date_signed:2', 'date_signed:3']);
  clearOfText(found, items);
  for (const a of found) for (const b of found) if (a !== b) assert.equal(overlap(a, b), 0, 'no two fields touch');
  // The last column is as wide as the others, not squeezed and not off the page.
  const last = pts(found.find((f) => f.signer === 3 && f.type === 'signature')!);
  assert.ok(last.x1 - last.x0 >= 100 && last.x1 <= 612 * 0.96);

  // A filled cell that starts 6 points after its label ends is still its own cell, because it starts where the
  // column starts on the other rows.
  const label = t('Email for notices', 290, 72);
  const tight = [t('Ana Silva', 200, label.x + label.w + 6), t('Sam Lee', 200, 330), t('Signature', 230, 72), t('Date', 260, 72), label, t('ana@example.org', 290, label.x + label.w + 6)];
  assert.deepEqual(brief(findInText(page(tight))), ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:2']);
});

test('a row that is already filled in gets nothing, and neither does a filled cell', () => {
  const items = [
    t('Client', 200, 200), t('Supplier', 200, 380),
    t('Name', 230, 72), t('Rosa Diaz', 230, 200), t('Tom Okafor', 230, 380),
    t('Company', 260, 72), t('Diaz Farms', 260, 200), t('Okafor Tools Ltd', 260, 380),
    t('Signature', 290, 72),
    t('Date', 330, 72), t('3 March 2026', 330, 380),
  ];
  const found = findInText(page(items));
  assert.deepEqual(brief(found), ['signature:1', 'signature:2', 'date_signed:1']);
  clearOfText(found, items);
  // The names typed into the Name row say whose column it is, whatever the order of the signers.
  assert.deepEqual(brief(assignSigners(findFields([page(items)]), ['Tom Okafor', 'Rosa Diaz'])), ['signature:2', 'signature:1', 'date_signed:2']);
  assert.deepEqual(brief(assignSigners(findFields([page(items)]), ['Rosa Diaz', 'Tom Okafor'])), ['signature:1', 'signature:2', 'date_signed:1']);
});

test('a ruled row with no header: the empty cells beside the label', () => {
  const items = [t('Signature', 340, 77), t('Date', 372, 77), t('1 May 2026', 372, 217)];
  const found = findInText(page(items, grid([72, 212, 540], [324, 356, 380])));
  assert.deepEqual(brief(found), ['signature:-']);
  const b = pts(found[0]);
  assert.ok(b.x0 >= 212 && b.x1 <= 540 && b.top >= 324 && b.bottom <= 356);
});

test('bare labels stacked at the end of a document', () => {
  // With colons, as before.
  const colons = [t('Signature:', 500), t('Name:', 540), t('Date:', 570)];
  const a = findInText(page(colons));
  assert.deepEqual(brief(a), ['signature:-', 'full_name:-', 'date_signed:-']);
  clearOfText(a, colons);
  assert.ok(pts(a[0]).x0 > 72 + helv.widthOfTextAtSize('Signature:', 11), 'the field starts after the label');

  // Without colons, a set of labels under each other still reads as a signature block.
  const plain = [t('The parties agree to the terms above.', 440), t('Signature', 500), t('Print name', 540), t('Date', 570)];
  const b = findInText(page(plain));
  assert.deepEqual(brief(b), ['signature:-', 'full_name:-', 'date_signed:-']);
  clearOfText(b, plain);
  for (const f of b) {
    const [label, line] = f.type === 'signature' ? ['Signature', 500] : f.type === 'full_name' ? ['Print name', 540] : ['Date', 570];
    assert.ok(pts(f).x0 > 72 + helv.widthOfTextAtSize(label, 11) && Math.abs(pts(f).bottom - line) < 5, `the ${f.type} field sits on its label's line, to the right of it`);
  }

  // A lone "Signed by:" as the last line.
  assert.deepEqual(brief(findInText(page([t('Thank you for planting with us.', 300), t('Signed by:', 420)]))), ['signature:-']);
  // "By:" over "Name:" and "Title:", as contracts in the United States end.
  assert.deepEqual(brief(findInText(page([t('By:', 500), t('Name:', 530), t('Title:', 560)]))), ['signature:-', 'full_name:-', 'title:-']);

  // No room to the right of the label: the field goes under it.
  const narrow = [t('Signature:', 500, 520), t('Date:', 580, 520)];
  const c = findInText(page(narrow));
  assert.deepEqual(brief(c), ['signature:-', 'date_signed:-']);
  assert.ok(pts(c[0]).top > 500 && pts(c[0]).bottom < 580 - 11, 'the signature sits between the two labels');
  assert.ok(pts(c[0]).x1 <= 612);
  clearOfText(c, narrow);

  // A label printed under a drawn line: the field goes on the line.
  const under = [t('Signature', 520, 72, 9), t('Date', 520, 330, 9)];
  const lines: Rule[] = [{ x: 72, y: 506, w: 200, h: 0.5 }, { x: 330, y: 506, w: 120, h: 0.5 }];
  const d = findInText(page(under, lines));
  assert.deepEqual(brief(d), ['signature:-', 'date_signed:-']);
  for (const f of d) assert.ok(pts(f).bottom <= 506 && pts(f).bottom > 500, 'the field stands on the line');
  assert.ok(Math.abs(pts(d[0]).x0 - 72) < 1 && pts(d[0]).x1 <= 272.5);
});

test('two signature blocks side by side under party headings: one person each', () => {
  const items = [
    t('For Company A', 470, 72), t('For Company B', 470, 330),
    t('Signature:', 510, 72), t('Signature:', 510, 330),
    t('Name:', 545, 72), t('Name:', 545, 330),
    t('Date:', 575, 72), t('Date:', 575, 330),
  ];
  const found = findInText(page(items));
  assert.deepEqual(brief(found), ['signature:1', 'signature:2', 'full_name:1', 'full_name:2', 'date_signed:1', 'date_signed:2']);
  clearOfText(found, items);
  for (const f of found) assert.ok(f.signer === 1 ? pts(f).x1 < 330 : pts(f).x0 > 330, 'each field stays on its own side');
  assert.deepEqual(found[0].who, ['For Company A']);
  assert.deepEqual(found[1].who, ['For Company B']);

  // The same with drawn blanks and the name printed under each line.
  const drawn = [
    t('Signature: ________________', 510, 72), t('Signature: ________________', 510, 330),
    t('Marc Diamond', 530, 72), t('James Cohen', 530, 330),
    t('Date: ___________', 560, 72), t('Date: ___________', 560, 330),
  ];
  const second = findFields([page(drawn)]);
  assert.deepEqual(brief(second), ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2']);
  // James is printed under the right-hand block, so the right-hand block is his, whatever the order of the columns.
  assert.deepEqual(brief(assignSigners(second, ['James Cohen', 'jimi cohen'])), ['signature:2', 'signature:1', 'date_signed:2', 'date_signed:1']);

  // Blocks under each other, each under its own heading.
  const stacked = [
    t('For Company A', 300), t('Signature:', 335), t('Date:', 365),
    t('For Company B', 450), t('Signature:', 485), t('Date:', 515),
  ];
  assert.deepEqual(brief(findInText(page(stacked))), ['signature:1', 'date_signed:1', 'signature:2', 'date_signed:2']);
  // Without headings nothing says they are two people, so they stay with whoever is picked in the editor.
  assert.deepEqual(brief(findInText(page(stacked.filter((i) => !i.str.startsWith('For'))))), ['signature:-', 'date_signed:-', 'signature:-', 'date_signed:-']);
  // One person's form with two different blanks on a line is still one person.
  assert.deepEqual(brief(findInText(page([t('Full name: ______________________     Date: ______________', 300)]))), ['full_name:-', 'date_signed:-']);
});

test('a name over a column beats the order of the columns', () => {
  const swapped = ownerTable().map((i) => (i.str === 'James Cohen' ? t('Marc Diamond', i.y, i.x) : i.str === 'Marc Diamond' ? t('Mr. James R. Cohen', i.y, i.x) : i)).filter((i) => !i.str.includes('@'));
  const found = findFields([page(swapped)]);
  assert.deepEqual(brief(found), ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:1', 'email:2']);
  // James is the first signer but his name is over the second column. Marc is nobody's name, so the first column
  // goes to the signer that is left.
  assert.deepEqual(brief(assignSigners(found, ['James Cohen', 'jimi cohen'])), ['signature:2', 'signature:1', 'date_signed:2', 'date_signed:1', 'email:2', 'email:1']);
  // Both named: order plays no part.
  assert.deepEqual(brief(assignSigners(found, ['marc diamond', 'JAMES COHEN'])), ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:1', 'email:2']);
  assert.deepEqual(brief(assignSigners(found, ['Zoe Able', 'James Cohen', 'Marc Diamond'])), ['signature:3', 'signature:2', 'date_signed:3', 'date_signed:2', 'email:3', 'email:2']);
  // Only one signer on the document, and it is James: the other column waits for a second signer.
  assert.deepEqual(brief(assignSigners(found, ['James Cohen'])), ['signature:2', 'signature:1', 'date_signed:2', 'date_signed:1', 'email:2', 'email:1']);
  // Tags keep the number typed in them, and plain blanks stay without one.
  const mixed = findFields([page([t('{{signature2}}', 100), t('Name: ____________', 140)])]);
  assert.deepEqual(brief(assignSigners(mixed, ['James Cohen', 'jimi cohen'])), ['signature:2', 'full_name:-']);

  assert.ok(namesMatch('James Cohen', 'james cohen'));
  assert.ok(namesMatch('Dr. James R. Cohen, Director', 'James Cohen'));
  assert.ok(namesMatch('For and on behalf of José Álvarez', 'Jose Alvarez'));
  assert.ok(!namesMatch('James Cohen', 'jimi cohen'));
  assert.ok(!namesMatch('Marc Diamond', 'James Cohen'));
  assert.ok(!namesMatch('Signature', ''));
});

test('words that only look like labels place nothing', () => {
  const none: [string, PageScan][] = [
    ['sentences that mention a signature and a date', page([
      t('Each party confirms that its signature below is made by a person with authority to sign,', 100),
      t('and that the date of signature is the date on which this agreement takes effect.', 114),
      t('Signed copies may be exchanged by email.', 128),
    ])],
    ['headings', page([t('Signature page', 100, 72, 16), t('The parties sign below in the presence of each other.', 130), t('Background sources', 200, 72, 14), t('Title', 260, 72, 16), t('A short history of the mangrove.', 284)])],
    ['a heading that is exactly one label, followed by text', page([t('Signature', 100, 72, 16), t('By signing, each party accepts the terms of this agreement in full.', 124), t('Date', 180, 72, 16), t('This agreement starts on 1 March 2026.', 204)])],
    ['a label with its answer already written', page([t('Date of this agreement: 1 March 2026', 100), t('Name: Rosa Diaz', 130), t('Signature: Rosa Diaz', 160), t('Date:', 190), t('5 March 2026', 190, 140)])],
    ['a data table with a Date column full of dates', page([
      t('Item', 200, 72), t('Date', 200, 220), t('Amount', 200, 380),
      t('Seedlings', 222, 72), t('1 March 2026', 222, 220), t('120.00', 222, 380),
      t('Transport', 244, 72), t('4 March 2026', 244, 220), t('35.50', 244, 380),
      t('Date', 266, 72), t('9 March 2026', 266, 220), t('80.00', 266, 380),
    ])],
    ['a table of contents', page([t('Contents', 80, 72, 14), t('Definitions ................................................ 2', 110), t('Signatures ................................................. 12', 128), t('Signature ................................................... 13', 146), t('Date ............................................................ 14', 164)])],
    ['a form that is already filled in, as a table', page([
      t('Buyer', 200, 220), t('Seller', 200, 380),
      t('Name', 226, 72), t('Rosa Diaz', 226, 220), t('Tom Okafor', 226, 380),
      t('Date', 252, 72), t('1 March 2026', 252, 220), t('2 March 2026', 252, 380),
      t('Email', 278, 72), t('rosa@example.org', 278, 220), t('tom@example.org', 278, 380),
    ])],
    ['a sign-in sheet header with rows under it', page([t('Name', 200, 72), t('Signature', 200, 220), t('Date', 200, 380), t('Rosa Diaz', 222, 72), t('Tom Okafor', 244, 72)])],
    ['the same sheet with its borders drawn', page([t('Name', 200, 77), t('Signature', 200, 225), t('Date', 200, 385), t('Rosa Diaz', 222, 77), t('Tom Okafor', 244, 77)], grid([72, 220, 380, 540], [186, 208, 230, 252]))],
    ['a letter with the date on the right and a word on the left', page([t('12 March 2026', 100, 420), t('Dear Rosa,', 150), t('Thank you for your letter about the title of the land.', 180)])],
  ];
  for (const [what, scan] of none) assert.deepEqual(findFields([scan]), [], what);

  for (const [text, type] of [['Signature', 'signature'], ['Signature:', 'signature'], ['Authorised signature', 'signature'], ['Sign', 'signature'], ['Signed', 'signature'], ['Signed by:', 'signature'], ['Date', 'date_signed'],
    ['Date signed', 'date_signed'], ['Name', 'full_name'], ['Print name', 'full_name'], ['Full name:', 'full_name'], ['Title', 'title'], ['Position', 'title'], ['Company', 'company'], ['Initials', 'initials'], ['Email', 'email'],
    ['Email for notices', 'email'], ['Signature page', null], ['Signatures', null], ['Date of this agreement', null], ['Date of birth', null], ['Background sources', null], ['Signed by the parties below', null], ['Name of the game', null]] as const)
    assert.equal(standaloneLabel(text), type, text);
});

test('a real PDF like the owner\'s, read with pdf.js, gets its fields inside the right cells', async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p1 = d.addPage([612, 792]);
  ['Memorandum of Understanding', '', 'This memorandum is made between Treegens and Diamond Forestry Ltd.', 'The parties will plant and verify mangrove seedlings together.']
    .forEach((l, i) => p1.drawText(l, { x: 72, y: 700 - i * 20, size: i ? 11 : 18, font }));
  const p2 = d.addPage([612, 792]);
  const top = (y: number) => 792 - y; // the table is described from the top of the page, as above
  p2.drawText('IN WITNESS WHEREOF the parties have signed this memorandum on the dates below.', { x: 72, y: top(270), size: 10, font });
  for (const x of COLS) p2.drawLine({ start: { x, y: top(ROWS[0]) }, end: { x, y: top(ROWS[4]) }, thickness: 0.75, color: rgb(0, 0, 0) });
  // Half of the row lines are drawn as thin filled boxes, which is how some word processors draw a border.
  ROWS.forEach((y, i) => (i % 2 ? p2.drawRectangle({ x: COLS[0], y: top(y) - 0.4, width: COLS[3] - COLS[0], height: 0.8, color: rgb(0, 0, 0) }) : p2.drawLine({ start: { x: COLS[0], y: top(y) }, end: { x: COLS[3], y: top(y) }, thickness: 0.75 })));
  for (const [str, y, x] of [['James Cohen', 316, 217], ['Marc Diamond', 316, 381], ['Signature', 340, 77], ['Date', 388, 77], ['Email for notices', 412, 77], ['jimi@treegens.org', 412, 217]] as const)
    p2.drawText(str, { x, y: top(y), size: 11, font });

  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await d.save()), verbosity: 0 }).promise;
  const pages = await scanPdf(doc);
  await doc.destroy();

  assert.equal(pages[0].rules, undefined, 'a page with no label is not searched for lines');
  const rules = pages[1].rules!;
  assert.equal(rules.filter((r) => r.h > r.w).length, 4, 'the four upright borders');
  const level = rules.filter((r) => r.w >= r.h);
  assert.ok(level.every((r) => ROWS.some((y) => Math.abs(r.y - y) < 0.5)) && ROWS.every((y) => level.some((r) => Math.abs(r.y - y) < 0.5)), 'the five level borders, each where it was drawn');
  assert.ok(rules.some((r) => Math.abs(r.y + r.h / 2 - ROWS[1]) < 0.5 && Math.abs(r.x - COLS[0]) < 0.5), 'a border drawn as a thin box is read as a line through its middle');

  const found = assignSigners(findFields(pages), ['James Cohen', 'jimi cohen']);
  assert.deepEqual(found.map((f) => `${f.page}:${f.type}:${f.signer}`), ['1:signature:1', '1:signature:2', '1:date_signed:1', '1:date_signed:2', '1:email:2']);
  for (const f of found) {
    const b = pts(f), col = f.signer === 1 ? [COLS[1], COLS[2]] : [COLS[2], COLS[3]];
    const row = f.type === 'signature' ? [ROWS[1], ROWS[2]] : f.type === 'date_signed' ? [ROWS[2], ROWS[3]] : [ROWS[3], ROWS[4]];
    assert.ok(b.x0 > col[0] && b.x1 < col[1] && b.top > row[0] && b.bottom < row[1], `${f.type} for signer ${f.signer} is inside its cell`);
  }

  // A clipping path draws nothing, and a path under a moved origin lands where it is drawn.
  const OPS = pdfjs.OPS;
  const made = rulesFrom(
    [OPS.constructPath, OPS.clip, OPS.endPath, OPS.save, OPS.transform, OPS.constructPath, OPS.stroke, OPS.restore, OPS.constructPath, OPS.fill],
    [[[OPS.rectangle], [0, 0, 300, 300]], null, null, null, [1, 0, 0, 1, 100, 100], [[OPS.moveTo, OPS.lineTo], [0, 0, 200, 0]], null, null, [[OPS.rectangle], [0, 0, 612, 792]], null],
    [1, 0, 0, -1, 0, 792], LETTER,
  );
  assert.deepEqual(made, [{ x: 100, y: 692, w: 200, h: 0 }]);
});

test('a PDF exported by a word processor (LibreOffice) gets the same fields, with and without its borders', async () => {
  // tests/fixtures/place-labels-mou.pdf was made from place-labels-mou.html next to it with
  //   soffice --headless --convert-to pdf:writer_pdf_Export place-labels-mou.html
  // Its last page ends with the owner's table: a header of two names, then Signature, Date and Email for notices.
  const { readFileSync } = await import('node:fs');
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(new URL('./fixtures/place-labels-mou.pdf', import.meta.url))), verbosity: 0 }).promise;
  const pages = await scanPdf(doc);
  await doc.destroy();
  assert.equal(pages.length, 2);
  assert.ok((pages[1].rules || []).length >= 8, 'the borders of the table were read');

  for (const [how, scans] of [['with borders', pages], ['text only', pages.map(({ rules: _rules, ...p }) => p)]] as const) {
    const found = assignSigners(findFields(scans), ['James Cohen', 'jimi cohen']);
    assert.deepEqual(found.map((f) => `${f.page}:${f.type}:${f.signer}`), ['1:signature:1', '1:signature:2', '1:date_signed:1', '1:date_signed:2', '1:email:2'], how);
    const { w, h } = scans[1].size;
    const at = (str: string) => scans[1].items.find((i) => i.str.trim() === str)!;
    for (const f of found) {
      const head = at(f.signer === 1 ? 'James Cohen' : 'Marc Diamond'), label = at(f.type === 'signature' ? 'Signature' : f.type === 'date_signed' ? 'Date' : 'Email for notices');
      // Under its own header, clear of the other column, and on the row of its label.
      assert.ok(Math.abs(f.x * w - head.x) < 8, `${how}: ${f.type} starts under "${head.str}"`);
      if (f.signer === 1) assert.ok((f.x + f.w) * w < at('Marc Diamond').x, `${how}: ${f.type} stops before the next column`);
      assert.ok((f.x + f.w) * w < w * 0.96 && f.w * w > 60);
      assert.ok(f.y * h < label.y && (f.y + f.h) * h > label.y - label.h, `${how}: ${f.type} is on the row of "${label.str}"`);
      for (const i of scans[1].items) assert.ok(!(i.x < (f.x + f.w) * w && i.x + i.w > f.x * w && i.y - 0.8 * i.h < (f.y + f.h) * h && i.y > f.y * h), `${how}: ${f.type} covers "${i.str}"`);
    }
  }
  // The first page is ordinary text with the words "signature" and "date" in it. Nothing is placed there.
  assert.deepEqual(findFields(pages).filter((f) => f.page === 0), []);
});

// ---- Found by the reviewers: each of these went wrong once ---------------------------------------------------------

const OWNER5 = ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:2'];
/** Every field of the owner's table sits in its own cell. */
const inOwnerCells = (found: Omit<Found, 'page'>[], what: string, dy = 0) => {
  for (const f of found) {
    const b = pts(f), col = f.signer === 1 ? [COLS[1], COLS[2]] : [COLS[2], COLS[3]];
    const row = f.type === 'signature' ? [ROWS[1], ROWS[2]] : f.type === 'date_signed' ? [ROWS[2], ROWS[3]] : [ROWS[3], ROWS[4]];
    assert.ok(b.x0 >= col[0] && b.x1 <= col[1] && b.top >= row[0] + dy - 1 && b.bottom <= row[1] + dy + 1, `${what}: ${f.type} for signer ${f.signer} is inside its cell`);
  }
};

test('a line just above the table is not its header: a centred heading, an indented line, a place and date on the right', () => {
  const above: [string, TextItem[]][] = [
    ['a centred heading', [t('SIGNATURES', 290, 270, 12)]],
    ['an indented line', [t('The parties sign here.', 290, 108)]],
    ['a place and date set to the right', [t('Addis Ababa, 12 March 2026', 290, 400)]],
    ['a heading and a line', [t('SIGNATURES', 268, 270, 12), t('Signed in two copies.', 290, 108)]],
  ];
  for (const [what, extra] of above) {
    const items = [...ownerTable().slice(1), ...extra];
    for (const [how, scan] of [['text only', page(items)], ['with borders', page(items, grid(COLS, ROWS))]] as const) {
      const found = findInText(scan);
      assert.deepEqual(brief(found), OWNER5, `${what}, ${how}`);
      inOwnerCells(found, `${what}, ${how}`);
      clearOfText(found, items);
      // The names over the columns are still read, so the columns go by name: Marc first on the document, James second.
      assert.deepEqual(brief(assignSigners(findFields([scan]), ['Marc Diamond', 'James Cohen'])), ['signature:2', 'signature:1', 'date_signed:2', 'date_signed:1', 'email:1'], `${what}, ${how}`);
    }
  }
  // A title row inside the table that runs over both columns.
  const merged = [...ownerTable().slice(1), t('SIGNATURES', 292, 270)];
  const borders = [...grid(COLS, ROWS), { x: 72, y: 276, w: 468, h: 0 }, { x: 72, y: 276, w: 0, h: 24 }, { x: 540, y: 276, w: 0, h: 24 }];
  for (const scan of [page(merged), page(merged, borders)]) {
    const found = findInText(scan);
    assert.deepEqual(brief(found), OWNER5);
    assert.deepEqual(found[0].who, ['James Cohen']);
    inOwnerCells(found, 'merged title row');
  }
  // A table with drawn borders and no header row at all, under a centred heading: the heading is not a column.
  const bare = [t('SIGNATURES', 310, 270, 12), t('Signature', 340, 77), t('Date', 388, 77)];
  const lone = findInText(page(bare, grid([72, 212, 540], [324, 372, 396])));
  assert.deepEqual(brief(lone), ['signature:-', 'date_signed:-']);
  for (const f of lone) assert.ok(pts(f).x0 >= 212 && pts(f).x1 <= 540, 'in the empty cell beside the label, not in the label column');
});

test('the line that leads into the signatures is not a place to sign', () => {
  for (const lead of ['Signed by the parties:', 'Signed by both parties:', 'Signed by:', 'Signed for and on behalf of the parties:', 'Signed for the organisations:']) {
    const items = [...ownerTable().slice(1), t(lead, 286)];
    for (const scan of [page(items), page(items, grid(COLS, ROWS))]) {
      const found = assignSigners(findFields([scan]), ['James Cohen', 'jimi cohen']);
      assert.deepEqual(brief(found), OWNER5, lead);
      inOwnerCells(found, lead);
    }
  }
  // The same kind of line over signature blocks, with no table.
  const blocks = [t('Schedule 1. Signed for the organisations:', 300), t('Signature: ______________', 340), t('Date: ___________', 370)];
  assert.deepEqual(brief(findInText(page(blocks))), ['signature:-', 'date_signed:-']);
  // A real place to sign that ends in a colon stays.
  assert.deepEqual(brief(findInText(page([t('Client signature:', 300), t('Date:', 330)]))), ['signature:-', 'date_signed:-']);
  // The space after a colon label is not empty when someone typed a little above the line.
  assert.deepEqual(findInText(page([t('Signature:', 130), t('Rosa Diaz', 126, 135)])), []);
});

test('signer numbers never run past the people on the document when everyone has a place', () => {
  const named = [t('James Cohen', 316, 217), t('Marc Diamond', 316, 381), t('Signature', 340, 77), t('Date', 388, 77)];
  const company = [t('Treegens DAO', 316, 217), t('Diamond Forestry Ltd', 316, 381), t('Signature', 340, 77), t('Date', 388, 77)];
  const two = ['James Cohen', 'jimi cohen'];
  const where = (found: Found[]) => found.map((f) => `p${f.page}:${f.type}:${f.signer ?? '-'}`);
  // A table with names on one page and a table with company names on the next: each table is worked out by itself.
  assert.deepEqual(where(assignSigners(findFields([page(named), page(company)]), two)),
    ['p0:signature:1', 'p0:signature:2', 'p0:date_signed:1', 'p0:date_signed:2', 'p1:signature:1', 'p1:signature:2', 'p1:date_signed:1', 'p1:date_signed:2']);
  // The same with two blanks side by side on the second page.
  const blanks = page([t('Signature: ______________', 300, 72), t('Signature: ______________', 300, 330)]);
  assert.deepEqual(where(assignSigners(findFields([page(named), blanks]), two)).slice(4), ['p1:signature:1', 'p1:signature:2']);
  // Labels set against the right of their cells are rows of the same table as the rest.
  const right = (str: string, top: number): TextItem => { const i = t(str, top); return { ...i, x: 207 - i.w }; };
  const flush = [t('James Cohen', 316, 217), t('Marc Diamond', 316, 381), right('Signature', 340), right('Date', 388), right('Email for notices', 412)];
  for (const scan of [page(flush), page(flush, grid(COLS, ROWS))])
    assert.deepEqual(brief(assignSigners(findFields([scan]), two)), ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:1', 'email:2']);
  // More columns than signers: only then is somebody missing. James is named over the third column.
  const three = [t('Ana Silva', 316, 180), t('Witness', 316, 310), t('James Cohen', 316, 440), t('Signature', 340, 77)];
  assert.deepEqual(brief(assignSigners(findFields([page(three)]), two)), ['signature:3', 'signature:2', 'signature:1']);

  // Nobody gets two columns, and the closest name wins.
  const junior = [t('James Cohen Jr.', 316, 217), t('James Cohen', 316, 381), t('Signature', 340, 77)];
  assert.deepEqual(brief(assignSigners(findFields([page(junior)]), ['James Cohen', 'James Cohen Jr'])), ['signature:2', 'signature:1']);
  const short = [t('James Cohen', 316, 217), t('James Diamond', 316, 381), t('Signature', 340, 77)];
  assert.deepEqual(brief(assignSigners(findFields([page(short)]), ['James', 'Marc'])), ['signature:1', 'signature:2']);
  assert.ok(!namesMatch('Cohen & James LLP', 'James Cohen'));
  assert.ok(!namesMatch('James Smith and Ana Cohen of Cohen Farms', 'James Cohen'));
  assert.ok(namesMatch('Cohen, James', 'James Cohen'));
  assert.ok(namesMatch('JAMES R. COHEN', 'James Cohen'));
  // A witness named near a signature is not the signer.
  const witness = findFields([page([t('Signature:', 500), t('Witnessed by Marc Diamond', 520), t('Name:', 560)])]);
  assert.deepEqual(brief(assignSigners(witness, ['James Cohen', 'Marc Diamond'])), ['signature:-', 'full_name:-']);

  // A company over the name in the same header cell, or the names typed into a Name row: still matched by name.
  const twoLine = [t('Treegens DAO', 304, 217), t('Diamond Forestry Ltd', 304, 381), t('James Cohen', 318, 217), t('Marc Diamond', 318, 381), t('Signature', 350, 77), t('Date', 398, 77)];
  for (const scan of [page(twoLine), page(twoLine, grid(COLS, [290, 326, 374, 406]))]) {
    const found = findFields([scan]);
    assert.deepEqual(found[0].who, ['James Cohen', 'Treegens DAO']);
    assert.deepEqual(brief(assignSigners(found, ['Marc Diamond', 'James Cohen'])), ['signature:2', 'signature:1', 'date_signed:2', 'date_signed:1']);
  }
});

test('one signer, or one place to sign each and nothing to say whose is whose', () => {
  // Two "Signature: ____  Date: ____" lines under each other, two signers: one line each, top to bottom.
  const lines2 = [t('Signature: ______________________', 300), t('Date: ____________', 300, 330), t('Signature: ______________________', 350), t('Date: ____________', 350, 330)];
  const found = findFields([page(lines2)]);
  assert.deepEqual(brief(found), ['signature:-', 'date_signed:-', 'signature:-', 'date_signed:-']);
  assert.deepEqual(brief(assignSigners(found, ['James Cohen', 'jimi cohen'])), ['signature:1', 'date_signed:1', 'signature:2', 'date_signed:2']);
  // Name, signature and date stacked twice.
  const stacked = [t('Name:', 300), t('Signature:', 335), t('Date:', 365), t('Name:', 430), t('Signature:', 465), t('Date:', 495)];
  assert.deepEqual(brief(assignSigners(findFields([page(stacked)]), ['Ana Silva', 'Sam Lee'])), ['full_name:1', 'signature:1', 'date_signed:1', 'full_name:2', 'signature:2', 'date_signed:2']);
  // One signer, or three: nothing says who signs where, so the places stay with whoever is picked.
  assert.deepEqual(brief(assignSigners(found, ['James Cohen'])), ['signature:-', 'date_signed:-', 'signature:-', 'date_signed:-']);
  assert.deepEqual(brief(assignSigners(found, ['A B', 'C D', 'E F'])), ['signature:-', 'date_signed:-', 'signature:-', 'date_signed:-']);
  // One signer and two blanks on a line with no names (a signature and a witness): both stay with that signer.
  const pair = findFields([page([t('Signature: ______________', 300, 72), t('Witness signature: ______________', 300, 300)])]);
  assert.deepEqual(brief(pair), ['signature:1', 'signature:2']);
  assert.deepEqual(brief(assignSigners(pair, ['James Cohen'])), ['signature:-', 'signature:-']);
  assert.deepEqual(brief(assignSigners(pair, ['James Cohen', 'jimi cohen'])), ['signature:1', 'signature:2']);
  // One signer and the owner's table: the other column has a name on it, so it waits for that person.
  const table = assignSigners(findFields([page(ownerTable())]), ['James Cohen']);
  assert.deepEqual(brief(table), ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:2']);
  assert.deepEqual(table.find((f) => f.signer === 2)!.who, ['Marc Diamond']);
  assert.ok(table.every((f) => f.set && f.set.startsWith('t')), 'the editor can tell these are columns of a table');
});

test('side by side blocks without colons, labels that wrap, labels under a line', () => {
  // Under party headings, no colons. This is not a table whose cells happen to hold the word Signature.
  const sides = [
    t('For Treegens DAO', 470, 72), t('For Diamond Forestry Ltd', 470, 330),
    t('Signature', 510, 72), t('Signature', 510, 330),
    t('Name', 545, 72), t('Name', 545, 330),
    t('Date', 580, 72), t('Date', 580, 330),
  ];
  const found = findInText(page(sides));
  assert.deepEqual(brief(found), ['signature:1', 'signature:2', 'full_name:1', 'full_name:2', 'date_signed:1', 'date_signed:2']);
  clearOfText(found, sides);
  assert.deepEqual(found[0].who, ['For Treegens DAO']);
  assert.deepEqual(found[1].who, ['For Diamond Forestry Ltd']);

  // "Email for" over "notices" in one cell is one label.
  const wrapped = [...ownerTable().slice(1, 5), t('Email for', 412, 77), t('notices', 425, 77), t('jimi@treegens.org', 412, 217)];
  for (const scan of [page(wrapped), page(wrapped, grid(COLS, [300, 324, 372, 396, 434]))]) assert.deepEqual(brief(findInText(scan)), OWNER5);

  // "____________" typed as text with the label under it: the field goes on the blank.
  const typed = [t('______________________', 100), t('Signature', 114, 72, 9), t('______________', 100, 330), t('Date', 114, 330, 9)];
  const onBlank = findInText(page(typed));
  assert.deepEqual(brief(onBlank), ['signature:-', 'date_signed:-']);
  for (const f of onBlank) assert.ok(Math.abs(pts(f).bottom - 100) < 4 && pts(f).x0 < 80 + (f.type === 'signature' ? 0 : 258), 'the field stands on the blank, not beside the label');

  // A drawn line, the name printed under it, and "Signature" under the name. The name says whose line it is.
  const lined = [t('James Cohen', 520, 72), t('Marc Diamond', 520, 330), t('Signature', 534, 72, 9), t('Signature', 534, 330, 9)];
  const lines: Rule[] = [{ x: 72, y: 506, w: 200, h: 0.5 }, { x: 330, y: 506, w: 200, h: 0.5 }];
  const onLine = findFields([page(lined, lines)]);
  assert.deepEqual(brief(onLine), ['signature:1', 'signature:2']);
  for (const f of onLine) assert.ok(pts(f).bottom <= 506 && pts(f).bottom > 500);
  assert.deepEqual(brief(assignSigners(onLine, ['Marc Diamond', 'James Cohen'])), ['signature:2', 'signature:1']);
  // A rule across the whole page over a heading is decoration, not a line to sign on.
  assert.deepEqual(findInText(page([t('Signature', 120), t('Each party signs below in ink.', 150)], [{ x: 72, y: 104, w: 468, h: 0.5 }])), []);

  // Rows too low to write in get nothing, and no field is ever a slit.
  const tiny = [t('A', 316, 217, 8), t('B', 316, 381, 8), t('Signature', 326, 77, 8), t('Date', 336, 77, 8)];
  assert.deepEqual(findInText(page(tiny, grid(COLS, [308, 318, 328, 338]))), []);
  // In a table every field is as wide as its cell, so the two columns look the same.
  const even = findInText(page(ownerTable(), grid(COLS, ROWS)));
  for (const f of even) assert.ok(Math.abs(pts(f).x1 - pts(f).x0 - (f.signer === 1 ? 147 : 147)) < 20, `${f.type} fills its cell`);
  assert.ok(Math.abs(even[0].w - even[2].w) < 0.001, 'the date is as wide as the signature over it');
});

test('more words that only look like labels: lists of people, lists of words, data with a gap', () => {
  const sheet = (pitch: number) => [t('Name', 200, 77), t('Signature', 200, 225), t('Date', 200, 385), t('Rosa Diaz', 200 + pitch, 77), t('Tom Okafor', 200 + 2 * pitch, 77)];
  const staff = [t('Name', 200, 77), t('Title', 200, 225), t('Email', 200, 385), t('Rosa Diaz', 232, 77), t('Director', 232, 225), t('rosa@example.org', 232, 385), t('Tom Okafor', 264, 77)];
  const sheetGrid = grid([72, 220, 380, 540], [180, 212, 244, 276]);
  const none: [string, PageScan][] = [
    ['a sign-in sheet with tall rows', page(sheet(32))],
    ['a sign-in sheet with very tall rows', page(sheet(38))],
    ['the same with borders', page(sheet(32), sheetGrid)],
    ['an empty sign-in sheet with borders', page(sheet(32).slice(0, 3), sheetGrid)],
    ['a staff list with tall rows', page(staff)],
    ['a staff list with borders', page(staff, sheetGrid)],
    ['a list of definitions, then numbered headings that are exactly a label', page([
      t('Company', 100), t('means Treegens DAO.', 100, 180), t('Date', 118), t('means the date of signing.', 118, 180), t('Title', 136), t('means ownership of the land.', 136, 180), t('Signature', 154), t('means a mark made by a person.', 154, 180),
      t('2. Title', 190, 72, 18), t('Title passes on payment.', 214), t('3. Date', 250, 72, 18), t('The date is 1 March 2026.', 274),
    ])],
    ['a paragraph whose last line is the one word signature', page([t('This deed is not valid without a wet-ink', 100), t('signature', 114), t('The next paragraph starts here and goes on for a while.', 160)])],
    ['a heading in the size of the body text with space under it', page([t('Signature', 100), t('Some text here about the deal and more.', 160)])],
    ['a wrapped word over a numbered heading', page([t('The parties agree that the effective', 100), t('Date', 114), t('2. Title', 140), t('Title to the goods passes on delivery.', 160)])],
    ['a list with bullets', page([t('The cover sheet states:', 90), t('• Title', 110), t('• Date', 126), t('• Signature', 142), t('of each party to the agreement.', 158)])],
    ['numbered clause headings', page([t('1. Name', 100), t('2. Date', 130), t('3. Signature', 160), t('4. Company', 190)])],
    ['an index of words', page([t('Index', 80, 72, 14), t('Company', 110), t('Date', 124), t('Email', 138), t('Name', 152), t('Position', 166), t('Signature', 180), t('Title', 194)])],
    ['a plan with one column still empty', page([
      t('Phase 1', 200, 200), t('Phase 2', 200, 320), t('Phase 3', 200, 440),
      t('Title', 226, 72), t('Survey', 226, 200), t('Planting', 226, 320),
      t('Date', 252, 72), t('March', 252, 200), t('June', 252, 320),
      t('Company', 278, 72), t('Treegens', 278, 200), t('Diamond', 278, 320),
    ], grid([67, 195, 315, 435, 545], [184, 210, 236, 262, 288]))],
    ['the same plan without borders', page([
      t('Phase 1', 200, 200), t('Phase 2', 200, 320), t('Phase 3', 200, 440),
      t('Title', 226, 72), t('Survey', 226, 200), t('Planting', 226, 320),
      t('Date', 252, 72), t('March', 252, 200), t('June', 252, 320),
    ])],
  ];
  for (const [what, scan] of none) assert.deepEqual(findFields([scan]).map((f) => `${f.type} at ${Math.round(f.x * 612)},${Math.round(f.y * 792)}`), [], what);
});

test('real word processor PDFs the reviewers made: a heading over the table, a lead-in line, a sign-in sheet', async () => {
  // Each PDF was printed by LibreOffice from the .html file of the same name next to it.
  const { readFileSync } = await import('node:fs');
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const read = async (name: string) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(new URL(`./fixtures/${name}.pdf`, import.meta.url))), verbosity: 0 }).promise;
    const pages = await scanPdf(doc);
    await doc.destroy();
    return [pages, pages.map(({ rules: _rules, ...p }) => p)] as PageScan[][];
  };
  const want = ['signature:1', 'signature:2', 'date_signed:1', 'date_signed:2', 'email:2'];
  for (const name of ['place-labels-heading', 'place-labels-leadin']) {
    for (const scans of await read(name)) {
      const how = `${name}, ${scans[0].rules ? 'with borders' : 'text only'}`;
      const found = assignSigners(findFields(scans), ['James Cohen', 'jimi cohen']);
      assert.deepEqual(brief(found), want, how);
      const { w, h } = scans[0].size;
      const at = (str: string) => scans[0].items.find((i) => i.str.trim() === str)!;
      for (const f of found) {
        const head = at(f.signer === 1 ? 'James Cohen' : 'Marc Diamond'), label = at(f.type === 'signature' ? 'Signature' : f.type === 'date_signed' ? 'Date' : 'Email for notices');
        assert.ok(Math.abs(f.x * w - head.x) < 8, `${how}: ${f.type} starts under "${head.str}"`);
        assert.ok(f.y * h < label.y && (f.y + f.h) * h > label.y - label.h, `${how}: ${f.type} is on the row of "${label.str}"`);
        for (const i of scans[0].items) assert.ok(!(i.x < (f.x + f.w) * w && i.x + i.w > f.x * w && i.y - 0.8 * i.h < (f.y + f.h) * h && i.y > f.y * h), `${how}: ${f.type} covers "${i.str}"`);
      }
      // The other way round on the document: the names over the columns still decide.
      assert.deepEqual(brief(assignSigners(findFields(scans), ['Marc Diamond', 'James Cohen'])), ['signature:2', 'signature:1', 'date_signed:2', 'date_signed:1', 'email:1'], how);
    }
  }
  for (const scans of await read('place-labels-signin')) assert.deepEqual(findFields(scans), []);
});
