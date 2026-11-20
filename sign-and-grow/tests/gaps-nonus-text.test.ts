// What people outside the US and outside the Latin alphabet ran into: names and answers in other scripts on the
// signed PDF, right-to-left text, date formats, time zones, how numbers are written, and correcting one's own name.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, signUp, upload, signAll, tokenFor, mailTo, simple, Client, PNG, type Server } from './helpers.ts';
import { extractPages } from '../src/server/text.ts';
import { visualRuns, isolate } from '../src/server/bidi.ts';
import { unprintable, fontsFrom } from '../src/server/pdftext.ts';
import { PRINT_MARK, codePoints, handwritingWrites, cannotPrintText } from '../src/lib/scripts.ts';

let s: Server;
before(async () => {
  s = await boot();
});

let n = 0;
const ip = () => `198.51.100.${++n}`;
const squash = (t: string) => t.replace(/\s+/g, '');

// One envelope, everyone signs at once. Each person gets a signature, their printed name and one field to type in.
async function sendTo(c: Client, people: { name: string; email: string; type?: string }[], over: any = {}) {
  const file = await upload(c, 1);
  const r = await c.post('/envelopes', {
    subject: 'Agreement', documents: [{ id: 'd', file_id: file.id, name: 'Agreement' }],
    recipients: people.map((p, i) => ({ id: `r${i}`, role: 'signer', name: p.name, email: p.email })),
    fields: people.flatMap((p, i) => [
      { id: `s${i}`, document_id: 'd', recipient_id: `r${i}`, type: 'signature', page: 0, x: 0.05, y: 0.04 + i * 0.075, w: 0.14, h: 0.04 },
      { id: `n${i}`, document_id: 'd', recipient_id: `r${i}`, type: 'full_name', page: 0, x: 0.22, y: 0.05 + i * 0.075, w: 0.32, h: 0.03 },
      { id: `t${i}`, document_id: 'd', recipient_id: `r${i}`, type: p.type || 'text', label: `Answer ${i + 1}`, page: 0, x: 0.58, y: 0.05 + i * 0.075, w: 0.36, h: 0.03 },
    ]),
    send: true, ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.envelope;
}
const fieldOf = (e: any, email: string, type: string) => {
  const r = e.recipients.find((x: any) => x.email === email);
  return e.fields.find((f: any) => f.recipient_id === r.id && f.type === type);
};
async function signedPages(c: Client, e: any, answers: Record<string, string>) {
  for (const r of e.recipients) {
    const t = e.fields.find((f: any) => f.recipient_id === r.id && f.label);
    const done = await signAll(e.id, r.email, { [t.id]: answers[r.email] ?? 'ok' });
    assert.equal(done.status, 200, JSON.stringify(done.data));
  }
  const pdf = await c.get(`/envelopes/${e.id}/download`);
  assert.equal(pdf.status, 200);
  return { pdf: pdf.data as Uint8Array, pages: await extractPages(pdf.data) };
}

// ---- A. Scripts the PDF fonts could not print ---------------------------------------------------

const PEOPLE = [
  { name: '王小明', email: 'wang@example.com', typed: '北京市朝阳区建国路' },
  { name: '山田 太郎', email: 'yamada@example.com', typed: 'とうきょう カタカナ 東京都' },
  { name: '김민준', email: 'kim@example.com', typed: '서울특별시 강남구' },
  { name: 'สมชาย ใจดี', email: 'somchai@example.com', typed: 'กรุงเทพมหานคร' },
  { name: 'राहुल शर्मा', email: 'rahul@example.com', typed: 'नई दिल्ली' },
  { name: 'محمد علي', email: 'mohamed@example.com', typed: 'القاهرة' },
  { name: 'សុខ សុភា', email: 'sok@example.com', typed: 'ភ្នំពេញ' },
  { name: 'Иван Петров', email: 'ivan@example.com', typed: 'Köln, Straße 5' },
];

// PDF text comes back in the order the glyphs stand on the page. For Devanagari and Khmer that is not always the
// typing order (a vowel sign drawn before its consonant, an r that sits on top of the next letter), so those are
// compared letter for letter, whatever the order. Pieces from different font files come back with a space between.
const letters = (t: string) => [...squash(t)].sort().join('');
const has = (text: string, want: string) => squash(text).includes(squash(want));

test('a signed PDF prints Chinese, Japanese, Korean, Thai, Hindi, Arabic, Khmer and Cyrillic names, and they can be read back out of it', async () => {
  const c = await signUp('Olga Sender', 'olga-scripts@example.com', ip());
  const e = await sendTo(c, PEOPLE);
  // Nothing here is flagged: every one of these scripts has a font.
  const page0 = (await c.get(`/envelopes/${e.id}`)).data;
  assert.deepEqual(page0.print_problems, []);
  const { pages } = await signedPages(c, e, Object.fromEntries(PEOPLE.map((p) => [p.email, p.typed])));
  const page = pages[0], cert = pages.slice(1).join(' ');
  for (const p of PEOPLE.filter((x) => !/rahul|sok/.test(x.email))) {
    assert.ok(has(page, p.name), `${p.name} is on the signed page`);
    assert.ok(has(page, p.typed), `${p.typed} is on the signed page`);
    assert.ok(has(cert, p.name), `${p.name} is in the certificate`);
  }
  // Hindi: the first name reads straight back, the surname has an r that is drawn above the letter after it.
  assert.ok(has(page, 'राहुल'));
  const surname = /राहुल\s*(\S+)/.exec(page)![1];
  assert.equal(letters(surname), letters('शर्मा'));
  assert.ok(has(cert, 'राहुल'));
  // Khmer: the name reads straight back, the city has a vowel that is drawn before its consonant.
  assert.ok(has(page, 'សុខ សុភា') && has(cert, 'សុខ សុភា'));
  assert.ok(squash(page).includes('ភ្នំ'));
  for (const ch of 'ពេញ') assert.ok(page.includes(ch));
  // No empty boxes, no replacement marks, and no list of characters that could not be printed.
  assert.ok(!pages.join(' ').includes(PRINT_MARK));
  assert.ok(!/could not print/i.test(cert));
  // The audit lines name people too: "Signed · 王小明 <wang@example.com>".
  assert.ok(/Signed\s*·\s*王\s*小明/.test(cert), cert.slice(-900));
});

test('a script with no font: the sender is told on the envelope page and before sending, the signer before finishing, and the PDF marks it and lists it', async () => {
  const c = await signUp('Priya Sender', 'priya-print@example.com', ip());
  const tamil = 'சுந்தர்';
  const e = await sendTo(c, [{ name: tamil, email: 'sundar@example.com' }, { name: 'Ana Lima', email: 'ana-print@example.com' }]);
  // The envelope page.
  const got = (await c.get(`/envelopes/${e.id}`)).data;
  assert.equal(got.print_problems.length, 1);
  assert.match(got.print_problems[0].where, /^The name சுந்தர்$/);
  assert.deepEqual([...got.print_problems[0].chars].sort(), [...new Set(tamil)].sort());
  // Before sending, with what is on screen and not saved yet.
  const before = await c.post('/print-check', { texts: [{ where: 'The subject', text: 'Lease' }, { where: 'The name X', text: tamil }, { where: 'A note on page 1', text: '王小明 and Köln are fine, 😀 too, but not ಕನ್ನಡ' }] });
  assert.equal(before.status, 200);
  assert.deepEqual(before.data.problems.map((p: any) => p.where), ['The name X', 'A note on page 1']);
  assert.deepEqual([...before.data.problems[1].chars].sort(), [...new Set('ಕನ್ನಡ')].sort());
  assert.equal((await c.post('/print-check', { texts: 'no' })).status, 400);
  // The signer, in the review dialog: their own name, and what they typed.
  const tok = tokenFor(e.id, 'sundar@example.com');
  const sc = new Client();
  assert.equal((await sc.post(`/sign/${tok}/consent`)).status, 200);
  const t = fieldOf(e, 'sundar@example.com', 'text');
  const asked = await sc.post(`/sign/${tok}/print-check`, { values: { [t.id]: 'மதுரை 625001' } });
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.data.problems.map((p: any) => [p.field_id, p.label]), [[null, 'Your name'], [t.id, 'Answer 1']]);
  assert.deepEqual([...asked.data.problems[1].chars].sort(), [...new Set('மதுரை')].sort());
  // Someone whose name and answers can all be printed is told nothing.
  const ana = new Client(), anaTok = tokenFor(e.id, 'ana-print@example.com');
  await ana.post(`/sign/${anaTok}/consent`);
  assert.deepEqual((await ana.post(`/sign/${anaTok}/print-check`, { values: {} })).data.problems, []);
  // The words they read say what happens and name the characters.
  assert.match(cannotPrintText('சு'), /cannot print these characters: ச ு\. On the document each is replaced by the mark �, and the certificate lists them by Unicode number/);
  // The signed PDF: a mark for each letter, never an empty box, and the certificate lists the characters by number.
  const { pages } = await signedPages(c, e, { 'sundar@example.com': 'மதுரை 625001', 'ana-print@example.com': 'fine' });
  assert.ok(pages[0].includes(PRINT_MARK.repeat(4)), pages[0]);
  assert.ok(pages[0].includes('625001'));
  const cert = pages.slice(1).join(' ');
  assert.match(cert, /CHARACTERS THIS PDF COULD NOT PRINT/);
  for (const ch of new Set(tamil + 'மதுரை')) assert.ok(cert.includes(codePoints(ch)), `${codePoints(ch)} is listed`);
  // Once it is signed and stored, the envelope page has nothing left to warn about.
  assert.deepEqual((await c.get(`/envelopes/${e.id}`)).data.print_problems, []);
});

test('a Noto font file that is missing or broken makes its script count as not printable, and the PDF is still built', async () => {
  const c = await signUp('Mei Sender', 'mei-fonts@example.com', ip());
  const e = await sendTo(c, [{ name: '王小明', email: 'wang-nofont@example.com' }, { name: 'สมชาย', email: 'somchai-nofont@example.com' }]);
  assert.equal(unprintable('王小明 สมชาย राहुल'), '');
  // A folder with DejaVu only, plus an index that names a Thai font which is not a font at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-fonts-'));
  for (const f of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']) fs.copyFileSync(path.join('assets', 'fonts', f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'noto'));
  fs.writeFileSync(path.join(dir, 'noto', 'thai.ttf'), 'this is not a font');
  fs.writeFileSync(path.join(dir, 'noto', 'index.json'), JSON.stringify({ fonts: [{ family: 'thai', file: 'thai.ttf', name: 'Broken', chars: 'สมชาย' }, { family: 'sc', file: 'sc/1.ttf', name: 'Gone', chars: '王小明' }] }));
  fontsFrom(dir);
  try {
    assert.equal(unprintable('王小明'), '王小明');
    assert.equal(unprintable('สมชาย'), [...new Set('สมชาย')].join(''));
    assert.equal(unprintable('Köln Иван محمد'), '');
    const told = (await c.get(`/envelopes/${e.id}`)).data.print_problems;
    assert.deepEqual(told.map((p: any) => p.where), ['The name 王小明', 'The name สมชาย']);
    const { pages } = await signedPages(c, e, {});
    assert.ok(pages[0].includes(PRINT_MARK.repeat(3)));
    assert.match(pages.slice(1).join(' '), /CHARACTERS THIS PDF COULD NOT PRINT/);
  } finally {
    fontsFrom(null);
  }
  assert.equal(unprintable('王小明 สมชาย'), '');
});

test('a typed signature offers four handwriting styles only when the handwriting fonts can write the name', () => {
  for (const name of ['Ana Lima', 'José Ångström', 'O\'Brien-Smith', 'Müller 山田', '']) assert.equal(handwritingWrites(name), true, name);
  for (const name of ['王小明', '山田 太郎', '김민준', 'Иван Петров', 'محمد علي', 'राहुल']) assert.equal(handwritingWrites(name), false, name);
});

// ---- B. Right-to-left text ------------------------------------------------------------------------

test('right-to-left text is put in reading order, with digits and Latin words left to right', () => {
  // The two cases that were printed wrong: house number 42 came out as 24, and "ABC 123" as "321 ... CBA".
  // Each piece is listed in the order it stands on the page from the left. A right-to-left piece keeps its letters
  // in typing order (the font lays them out from the right).
  assert.deepEqual(visualRuns('תל אביב 42'), { rtl: true, runs: [{ text: '42', rtl: false }, { text: 'תל אביב ', rtl: true }] });
  assert.deepEqual(visualRuns('شركة ABC رقم 123'), { rtl: true, runs: [{ text: '123', rtl: false }, { text: ' رقم ', rtl: true }, { text: 'ABC', rtl: false }, { text: 'شركة ', rtl: true }] });
  // Plain right-to-left text is one piece, and text with none is left exactly as it is.
  assert.deepEqual(visualRuns('محمد علي'), { rtl: true, runs: [{ text: 'محمد علي', rtl: true }] });
  assert.deepEqual(visualRuns('12 Main Street, Flat 4'), { rtl: false, runs: [{ text: '12 Main Street, Flat 4', rtl: false }] });
  // A number with its separators and its currency sign stays one number: 1,234.50 and 12.5%.
  assert.deepEqual(visualRuns('המחיר 1,234.50 ₪').runs, [{ text: ' ₪', rtl: true }, { text: '1,234.50', rtl: false }, { text: 'המחיר ', rtl: true }]);
  assert.deepEqual(visualRuns('نسبة 12.5%').runs, [{ text: '12.5%', rtl: false }, { text: 'نسبة ', rtl: true }]);
  // Persian is Arabic script, with its own digits: they keep their order too.
  assert.deepEqual(visualRuns('پلاک ۱۲۳ تهران').runs, [{ text: ' تهران', rtl: true }, { text: '۱۲۳', rtl: false }, { text: 'پلاک ', rtl: true }]);
  // Brackets around right-to-left words are mirrored, so they still open and close the right way round.
  assert.equal(visualRuns('(אבג)').runs[0].text, ')אבג(');
  // An English line with a right-to-left name in it: the line stays left to right and the name is ordered by itself.
  assert.deepEqual(visualRuns(`Signed · ${isolate('شركة ABC')} <a@b.example>`, 'ltr').runs.map((r) => r.text), ['Signed · ', 'ABC', 'شركة ', ' <a@b.example>']);
  // English text that mentions a Hebrew word and a number keeps the usual order for a left-to-right line.
  assert.deepEqual(visualRuns('Flat 4, רחוב הרצל').runs.map((r) => [r.text, r.rtl]), [['Flat 4, ', false], ['רחוב הרצל', true]]);
});

test('a Hebrew address with house number 42 and Arabic text with "ABC 123" are printed right on the signed PDF and the certificate', async () => {
  const c = await signUp('Dana Sender', 'dana-rtl@example.com', ip());
  const e = await sendTo(c, [{ name: 'דנה כהן', email: 'dana-signer@example.com' }, { name: 'شركة ABC', email: 'abc-signer@example.com' }], { subject: 'عقد رقم 2026' });
  const { pdf, pages } = await signedPages(c, e, { 'dana-signer@example.com': 'תל אביב 42', 'abc-signer@example.com': 'شركة ABC رقم 123' });
  // Read back, the text is in typing order again and the numbers are whole.
  assert.ok(has(pages[0], 'תל אביב 42'), pages[0]);
  assert.ok(has(pages[0], 'شركة ABC رقم 123'), pages[0]);
  assert.ok(!squash(pages[0]).includes('24') && !squash(pages[0]).includes('321') && !pages[0].includes('CBA'));
  const cert = pages.slice(1).join(' ');
  assert.ok(has(cert, 'דנה כהן') && has(cert, 'شركة ABC') && has(cert, 'عقد رقم 2026'), cert.slice(0, 600));
  assert.ok(!cert.includes('CBA') && !squash(cert).includes('6202'));
  // The words as typed are also written into the PDF beside the glyphs (ActualText), for programs that copy or
  // search text: on the page a right-to-left line does not stand in typing order.
  const utf16 = (t: string) => `FEFF${[...t].map((ch) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')}`;
  const drawn = await pageCode(pdf, 0);
  assert.ok(drawn.includes(`/ActualText <${utf16('תל אביב 42')}>`), 'the Hebrew address as typed');
  assert.ok(drawn.includes(`/ActualText <${utf16('شركة ABC رقم 123')}>`), 'the Arabic text as typed');
  // Where they stand: right-to-left text ends at the right edge of its box (2 points inside it), and the name of
  // the second signer, which starts with an Arabic word, does too. The page is 612 points wide.
  const items = await pageItems(pdf, 0);
  const rightEdge = (test: (t: string) => boolean) => Math.max(...items.filter((i) => test(i.str)).map((i) => i.x + i.w));
  const leftEdge = (test: (t: string) => boolean) => Math.min(...items.filter((i) => test(i.str)).map((i) => i.x));
  const box = (f: any) => ({ left: f.x * 612, right: (f.x + f.w) * 612 });
  const hebrew = box(fieldOf(e, 'dana-signer@example.com', 'text')), hebrewName = box(fieldOf(e, 'dana-signer@example.com', 'full_name'));
  assert.ok(Math.abs(rightEdge((t) => /[א-ת]/.test(t) && t.includes('אביב')) - (hebrew.right - 2)) < 1.5, 'the typed address ends at the right edge');
  assert.ok(Math.abs(rightEdge((t) => t.includes('דנה') || t.includes('כהן')) - (hebrewName.right - 2)) < 1.5, 'the printed name ends at the right edge');
  assert.ok(leftEdge((t) => t.includes('אביב') || t === '42') > hebrew.left + 40, 'and does not start at the left edge');
});

// The drawing instructions of one page, unpacked, to see what was written beside the glyphs.
async function pageCode(pdf: Uint8Array, index: number): Promise<string> {
  const { PDFDocument, PDFArray, decodePDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdf);
  const contents: any = doc.getPages()[index].node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r: any) => doc.context.lookup(r)) : [contents];
  return streams.map((st: any) => Buffer.from(decodePDFRawStream(st).decode()).toString('latin1')).join('\n');
}
// Every piece of text on a page with where it starts and how wide it is, in points from the left edge.
async function pageItems(pdf: Uint8Array, index: number): Promise<{ str: string; x: number; y: number; w: number }[]> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const content = await (await doc.getPage(index + 1)).getTextContent();
    return content.items.filter((i: any) => i.str && i.str.trim()).map((i: any) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width }));
  } finally {
    await doc.destroy().catch(() => {});
  }
}

test('the first letter of a line decides which way it reads, and a line can be told to read left to right', async () => {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const { Typesetter } = await import('../src/server/pdftext.ts');
  const fontkit: any = await import('@pdf-lib/fontkit');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit.default || fontkit);
  const font = await doc.embedFont(fs.readFileSync('assets/fonts/DejaVuSans.ttf'), { subset: true });
  const ts = new Typesetter(doc, font, font);
  const rtl = ts.layout('תל אביב 42'), ltr = ts.layout('Tel Aviv 42'), mixed = ts.layout('Flat 4, רחוב הרצל');
  assert.equal(rtl.rtl, true);
  assert.equal(ltr.rtl, false);
  assert.equal(mixed.rtl, false, 'the first letter decides');
  // The same words take the same room whichever way they run, so the right-aligned line ends where the box ends.
  assert.ok(rtl.width > 0 && Math.abs(rtl.width - ts.layout('42 תל אביב').width) < 1);
  // Drawing does not throw for either, and a line can be told to run left to right whatever its first letter is.
  const page = doc.addPage([300, 100]);
  ts.draw(page, rtl, { x: 10, y: 50, size: 10, color: rgb(0, 0, 0) });
  ts.draw(page, ltr, { x: 10, y: 30, size: 10, color: rgb(0, 0, 0) });
  assert.equal(ts.layout('תל אביב 42', { dir: 'ltr' }).rtl, false);
  const text = (await extractPages(await doc.save()))[0];
  assert.ok(has(text, 'תל אביב 42') && has(text, 'Tel Aviv 42'), text);
});
