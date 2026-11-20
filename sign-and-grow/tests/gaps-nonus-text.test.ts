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
import { DATE_FORMATS, DATE_FORMAT_CHOICES, formatDate, formatDateValue, clockIn, momentText, momentForEmail, localStamp, isDaytime, validZone, deviceZone } from '../src/lib/dates.ts';
import { isNumber, NUMBER_HINT, NUMBER_PROBLEM } from '../src/lib/numbers.ts';
import { problemWith } from '../src/components/sign/fields.ts';
import { deadlineLine, closingText } from '../src/components/sender/lib.ts';

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
  assert.match(cannotPrintText('சு'), /^The signed PDF cannot print these characters: சு\. On the PDF each of them is replaced by the mark \uFFFD, and the certificate lists them by Unicode number/);
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
  // Someone who types the invisible marks that turn text round cannot make 1234 print as 4321: they are dropped.
  assert.deepEqual(visualRuns('Pay ‮1234‬ now'), { rtl: false, runs: [{ text: 'Pay 1234 now', rtl: false }] });
  assert.deepEqual(visualRuns('‮תל אביב 42').runs.map((r) => r.text), ['42', 'תל אביב ']);
});

test('a Hebrew address with house number 42 and Arabic text with "ABC 123" are printed right on the signed PDF and the certificate', async () => {
  const c = await signUp('Dana Sender', 'dana-rtl@example.com', ip());
  const e = await sendTo(c, [{ name: 'דנה כהן', email: 'dana-signer@example.com' }, { name: 'شركة ABC', email: 'abc-signer@example.com' }], { subject: 'عقد رقم 2026' });
  const { pdf, pages } = await signedPages(c, e, { 'dana-signer@example.com': 'תל אביב 42', 'abc-signer@example.com': 'شركة ABC رقم 123' });
  // Read back, the text is in typing order again and the numbers are whole.
  assert.ok(has(pages[0], 'תל אביב 42'), pages[0]);
  assert.ok(has(pages[0], 'شركة ABC رقم 123'), pages[0]);
  // Not mirrored anywhere. (The captions under the signatures and the envelope number are random letters and
  // digits, so they are left out of this look.)
  const typed = pages[0].replace(/Signed via Sign&Grow · \S+/g, '').replace(/Envelope ID: \S+/g, '');
  assert.ok(!/24|321|CBA/.test(squash(typed)), typed);
  const cert = pages.slice(1).join(' ');
  assert.ok(has(cert, 'דנה כהן') && has(cert, 'شركة ABC') && has(cert, 'عقد رقم 2026'), cert.slice(0, 600));
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

test('every box a signer types words into takes its direction from what is typed', () => {
  // The signing page, its dialogs, the typed signature and the public form. Boxes for a code (the access code, the
  // code from an email) hold digits and letters the sender chose, not words, and are left out.
  const files = ['src/app/sign/[token]/page.tsx', 'src/app/f/[slug]/page.tsx', 'src/components/SignaturePad.tsx',
    ...fs.readdirSync('src/components/sign').filter((f) => f.endsWith('.tsx')).map((f) => `src/components/sign/${f}`)];
  const missing: string[] = [];
  let boxes = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // A box that spreads `shared` gets its dir from there, so every `shared` in these files must carry one.
    for (const m of src.matchAll(/const shared = \{[^\n]*/g)) if (!/dir: 'auto'/.test(m[0])) missing.push(`${f}: ${m[0].slice(0, 80)}`);
    for (const m of src.matchAll(/<(input|textarea)\b[\s\S]*?\/>/g)) {
      const type = /\btype="([a-z]+)"/.exec(m[0])?.[1];
      if ((m[1] === 'input' && type && type !== 'text') || /value=\{code\}/.test(m[0])) continue;
      boxes++;
      if (!/\bdir="auto"/.test(m[0]) && !/\{\.\.\.shared\}/.test(m[0])) missing.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.ok(boxes >= 12, `found ${boxes} boxes`);
  assert.deepEqual(missing, []);
});

// ---- C. Dates ------------------------------------------------------------------------------------

test('a date a signer picks is written in the format the sender chose: on the PDF and in what the next signer is shown', async () => {
  const c = await signUp('Uma Sender', 'uma-dates@example.com', ip());
  const e = await sendTo(c, [{ name: 'Ada Dates', email: 'ada-dates@example.com', type: 'date' }, { name: 'Ben Dates', email: 'ben-dates@example.com' }], { date_format: 'D MMM YYYY' });
  const d = fieldOf(e, 'ada-dates@example.com', 'date');
  assert.equal((await signAll(e.id, 'ada-dates@example.com', { [d.id]: '2026-03-04' })).status, 200);
  // Ben has not signed yet. On his screen Ada's date reads as it will on paper, not as 2026-03-04.
  const ben = new Client();
  const seen = (await ben.get(`/sign/${tokenFor(e.id, 'ben-dates@example.com')}`)).data;
  assert.equal(seen.envelope.date_format, 'D MMM YYYY');
  assert.equal(seen.others.find((o: any) => o.id === d.id).value, '4 Mar 2026');
  // What Ada's own page sends back to her is still the plain date, which the date picker needs.
  assert.equal((await new Client().get(`/sign/${tokenFor(e.id, 'ada-dates@example.com')}`)).data.fields.find((f: any) => f.id === d.id).value, '2026-03-04');
  assert.equal((await signAll(e.id, 'ben-dates@example.com')).status, 200);
  const page = (await extractPages((await c.get(`/envelopes/${e.id}/download`)).data))[0];
  assert.ok(page.includes('4 Mar 2026'), page);
  assert.ok(!page.includes('2026-03-04'), 'one page never carries two formats');
});

test('every format writes a typed date the same way it writes the date of signing, and anything that is not a date is left as typed', () => {
  assert.deepEqual(DATE_FORMATS.map((f) => formatDateValue('2026-11-20', f)), ['2026-11-20', '20/11/2026', '11/20/2026', '20 Nov 2026', 'Nov 20, 2026']);
  assert.deepEqual(DATE_FORMATS.map((f) => formatDate('2026-11-20T10:00:00.000Z', f)), DATE_FORMATS.map((f) => formatDateValue('2026-11-20', f)));
  for (const typed of ['20th of November', '20.11.2026', '2026-13-40', '2026-11-2', '']) assert.equal(formatDateValue(typed, 'D MMM YYYY'), typed);
  assert.equal(formatDateValue('2026-11-20'), '2026-11-20');
  // The picker lists the same formats, with the ones nobody can misread first.
  assert.deepEqual([...DATE_FORMAT_CHOICES].sort(), [...DATE_FORMATS].sort());
  assert.equal(DATE_FORMAT_CHOICES[0], 'D MMM YYYY');
});

test('an account sets the date format its new envelopes start with', async () => {
  const c = await signUp('Ines Admin', 'ines-dates@example.com', ip());
  assert.equal((await c.get('/me')).data.account.default_date_format, null);
  assert.equal((await simple(c, 'd0@example.com')).date_format, null, 'nothing chosen: year-month-day, as before');
  // One that does not exist is refused and nothing changes.
  const bad = await c.call('PATCH', '/account', { default_date_format: 'DD.MM.YYYY' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /does not exist\. Use one of: YYYY-MM-DD, DD\/MM\/YYYY/);
  assert.equal((await c.call('PATCH', '/account', { default_date_format: 'DD/MM/YYYY' })).status, 200);
  assert.equal((await c.get('/me')).data.account.default_date_format, 'DD/MM/YYYY');
  // Other settings saved without it leave it alone.
  assert.equal((await c.call('PATCH', '/account', { default_expire_days: 30 })).status, 200);
  assert.equal((await c.get('/me')).data.account.default_date_format, 'DD/MM/YYYY');
  const e = await simple(c, 'd1@example.com');
  assert.equal(e.date_format, 'DD/MM/YYYY');
  // Whoever sends can still choose another format for one envelope.
  assert.equal((await simple(c, 'd2@example.com', { date_format: 'MMM D, YYYY' })).date_format, 'MMM D, YYYY');
  // A template made now starts with it too, and envelopes made from the template keep the template's.
  const tpl = (await c.post('/envelopes', { kind: 'template', subject: 'T' })).data.envelope;
  assert.equal(tpl.date_format, 'DD/MM/YYYY');
  // Back to none.
  assert.equal((await c.call('PATCH', '/account', { default_date_format: '' })).status, 200);
  assert.equal((await simple(c, 'd3@example.com')).date_format, null);
});

// ---- E. Numbers as people write them ----------------------------------------------------------------

const NUMBERS = ['2500', '12.5', '12,5', '-40', '1,234.56', '1.234,56', '1 234,56', "1'234.56", '1,23,456', '12,34,567.50', '₹1,23,456', '€1.234,56', '1 234,56 €', '1.234.567', '١٢٣'];
const NOT_NUMBERS = ['abc', '12abc', '1,,2', '1.234.56', '1 234 56', '1,2,3', '12.', '.5', '1e5', '5 apples', '1,234,56', '--5'];

test('the signing page and the server use one rule for numbers, and it takes the ways numbers are written outside the US', () => {
  const field = { type: 'number', label: 'Amount' };
  for (const v of NUMBERS) {
    assert.equal(isNumber(v), true, v);
    assert.equal(problemWith(field, v), '', `the page accepts ${v}`);
  }
  for (const v of NOT_NUMBERS) {
    assert.equal(isNumber(v), false, v);
    assert.equal(problemWith(field, v), NUMBER_PROBLEM, `the page refuses ${v}`);
  }
  // The hint says how to write it and that nothing is converted.
  assert.match(NUMBER_HINT, /as you write it, like 2500, 1\.234,56 or 1,234\.56\. It is printed exactly as you type it\./);
});

test('a number field takes 1.234,56, 1 234,56, 1\'234.56 and Indian grouping, and the PDF prints exactly what was typed', async () => {
  const c = await signUp('Nora Sender', 'nora-numbers@example.com', ip());
  const typed = ['1.234,56', '1 234,56', "1'234.56", '1,23,456', '₹12,34,567.50', '1,234.56'];
  const people = typed.map((_, i) => ({ name: `Signer ${i + 1}`, email: `num${i}@example.com`, type: 'number' }));
  const e = await sendTo(c, people);
  // What is not a number is refused when finishing, with words that say how to write one. Nothing was signed.
  const f0 = fieldOf(e, 'num0@example.com', 'number');
  const no = await signAll(e.id, 'num0@example.com', { [f0.id]: '1.234.56' });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /"1\.234\.56" does not read as a number for Answer 1\. Type it as you write it, like 2500, 12\.5, 1\.234,56 or 1,234\.56/);
  const { pages } = await signedPages(c, e, Object.fromEntries(people.map((p, i) => [p.email, typed[i]])));
  for (const v of typed) assert.ok(pages[0].includes(v), `${v} is printed as typed: ${pages[0]}`);
});

// ---- D. Time zones -----------------------------------------------------------------------------------

// A zone where the clock shows this hour right now. (In these names the sign is the other way round: Etc/GMT-5 is
// five hours ahead of UTC.)
function zoneWhereItIs(hour: number): string {
  let off = hour - new Date().getUTCHours();
  while (off > 12) off -= 24;
  while (off < -11) off += 24;
  return off === 0 ? 'Etc/GMT' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}
// A zone whose calendar day is not the UTC day right now: fourteen hours ahead, or eleven behind.
const otherDayZone = () => (new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago');

// What the signing page does: the device's time zone goes along with consent and with Finish.
async function signInZone(envelopeId: string, email: string, tz: any, extra: Record<string, string> = {}) {
  const c = new Client();
  const tok = tokenFor(envelopeId, email);
  assert.equal((await c.post(`/sign/${tok}/consent`, { tz })).status, 200);
  const v = (await c.get(`/sign/${tok}`)).data;
  const values: Record<string, string> = { ...extra };
  for (const f of v.fields || []) if (!(f.id in values)) values[f.id] = f.type === 'text' ? 'filled in' : '1';
  return c.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG, tz });
}

test('the date of signing is the calendar day where the signer is, and the certificate gives their local time with its zone next to UTC', async () => {
  const c = await signUp('Kiri Sender', 'kiri-zones@example.com', ip());
  const zone = otherDayZone();
  const e = await sendTo(c, [{ name: 'Mele Far', email: 'mele@example.com', type: 'date_signed' }, { name: 'Una Utc', email: 'una@example.com', type: 'date_signed' }], { date_format: 'D MMM YYYY' });
  assert.equal((await signInZone(e.id, 'mele@example.com', zone)).status, 200);
  // Someone whose device says nothing, and a sender whose zone we never learned: UTC, as before.
  assert.equal((await signAll(e.id, 'una@example.com')).status, 200);
  const rows = Object.fromEntries(s.db.all('SELECT email, tz, completed_at FROM recipients WHERE envelope_id=?', e.id).map((r: any) => [r.email, r]));
  assert.equal(rows['mele@example.com'].tz, zone);
  assert.equal(rows['una@example.com'].tz, null);
  const local = formatDate(rows['mele@example.com'].completed_at, 'D MMM YYYY', zone), utc = formatDate(rows['mele@example.com'].completed_at, 'D MMM YYYY');
  assert.notEqual(local, utc, 'the test only means something when the two days differ');
  const pages = await extractPages((await c.get(`/envelopes/${e.id}/download`)).data);
  // Mele's date is her own day. Una's is the UTC day.
  assert.ok(pages[0].includes(local), pages[0]);
  assert.ok(pages[0].includes(formatDate(rows['una@example.com'].completed_at, 'D MMM YYYY')));
  // The certificate: the zone, the local time of each of her steps, and UTC as before.
  const cert = pages.slice(1).join(' ');
  assert.ok(cert.includes(`Time zone ${zone}, as reported by their device`), cert.slice(0, 1800));
  assert.ok(cert.includes(`Completed, their time ${localStamp(rows['mele@example.com'].completed_at, zone)}`));
  assert.match(cert, /Consent, their time \d{4}-\d\d-\d\d \d\d:\d\d UTC[+-]\d\d:\d\d, Pacific\//);
  assert.ok(cert.includes(`Completed ${rows['mele@example.com'].completed_at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`));
  // Her audit lines carry her local time too, and the zone itself is part of the hash-chained record.
  assert.match(cert, /Mele Far <mele@example\.com> · [^·]+ · [0-9a-f]{16} · their time \d{4}-\d\d-\d\d \d\d:\d\d UTC[+-]\d\d:\d\d, Pacific\//);
  const audit = (await c.get(`/envelopes/${e.id}`)).data.audit;
  const told = audit.filter((a: any) => a.action === 'Time zone reported');
  assert.equal(told.length, 1, 'said once, not again when Finish repeats the same zone');
  assert.match(told[0].detail, new RegExp(`^Mele Far: ${zone} \\(UTC[+-]\\d\\d:\\d\\d at this moment\\), as their device says\\.`));
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.chain.ok, true);
  // Nothing of the sort is said about Una.
  assert.ok(!/Una Utc <una@example\.com> · [^·]+ · [0-9a-f]{16} · their time/.test(cert));
});

test('with no zone from the signer the sender\'s zone decides the day, and something that is not a time zone is ignored', async () => {
  const c = await signUp('Sami Sender', 'sami-zones@example.com', ip());
  const zone = otherDayZone();
  // The app tells us the sender's zone when it loads.
  assert.equal((await c.call('GET', '/me', undefined, { 'x-tz': zone })).status, 200);
  const e = await sendTo(c, [{ name: 'Quiet Device', email: 'quiet@example.com', type: 'date_signed' }, { name: 'Odd Device', email: 'odd@example.com', type: 'date_signed' }], { date_format: 'DD/MM/YYYY' });
  assert.equal((await signAll(e.id, 'quiet@example.com')).status, 200);
  assert.equal((await signInZone(e.id, 'odd@example.com', 'Mars/Olympus; DROP TABLE recipients')).status, 200);
  const rows = s.db.all('SELECT email, tz, completed_at FROM recipients WHERE envelope_id=? ORDER BY email', e.id);
  assert.deepEqual(rows.map((r: any) => r.tz), [null, null]);
  const page = (await extractPages((await c.get(`/envelopes/${e.id}/download`)).data))[0];
  for (const r of rows) {
    assert.notEqual(formatDate(r.completed_at, 'DD/MM/YYYY', zone), formatDate(r.completed_at, 'DD/MM/YYYY'));
    assert.ok(page.includes(formatDate(r.completed_at, 'DD/MM/YYYY', zone)), page);
  }
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.audit.filter((a: any) => a.action === 'Time zone reported').length, 0);
});

test('a moment reads the same everywhere: with its time and its zone', () => {
  // The envelope from the complaint: one deadline, told as two different days.
  const closes = '2027-03-20T16:40:00.000Z';
  assert.equal(momentText(closes), '20 March 2027 at 16:40 UTC');
  assert.equal(momentText(closes, 'Pacific/Auckland'), '21 March 2027 at 05:40 Pacific/Auckland time (UTC+13:00)');
  assert.equal(momentText(closes, 'America/Los_Angeles'), '20 March 2027 at 09:40 America/Los Angeles time (UTC-07:00)');
  assert.equal(momentForEmail(closes), '20 March 2027 at 16:40 UTC');
  assert.equal(momentForEmail(closes, 'Asia/Kolkata'), '20 March 2027 at 16:40 UTC, which is 20 March 2027 at 22:10 Asia/Kolkata time (UTC+05:30)');
  assert.equal(momentForEmail(closes, 'not a zone'), '20 March 2027 at 16:40 UTC');
  // Summer time is followed: London is an hour ahead of UTC in July and not in January.
  assert.equal(clockIn('2026-07-01T23:30:00Z', 'Europe/London')!.offset, 'UTC+01:00');
  assert.equal(formatDate('2026-07-01T23:30:00Z', 'D MMM YYYY', 'Europe/London'), '2 Jul 2026');
  assert.equal(clockIn('2026-01-01T23:30:00Z', 'Europe/London')!.offset, 'UTC');
  // The examples from the research: the same moment is the 21st in Auckland and still the 20th in Los Angeles.
  assert.equal(formatDate('2026-11-20T16:40:43.000Z', 'DD/MM/YYYY', 'Pacific/Auckland'), '21/11/2026');
  assert.equal(formatDate('2026-11-21T03:40:00.000Z', 'DD/MM/YYYY', 'America/Los_Angeles'), '20/11/2026');
  assert.equal(formatDate('2026-11-20T16:40:43.000Z', 'DD/MM/YYYY'), '20/11/2026');
  assert.equal(validZone('Asia/Kolkata'), 'Asia/Kolkata');
  for (const no of ['', 'Nope/Nowhere', 'x'.repeat(80), null, 5, 'Europe/Berlin\nX']) assert.equal(validZone(no), null);
  // Daytime for reminders is 8:00 up to 20:00.
  assert.equal(isDaytime('2026-11-20T02:30:00Z', 'Asia/Kolkata'), true);  // 08:00 in India
  assert.equal(isDaytime('2026-11-20T02:29:00Z', 'Asia/Kolkata'), false); // 07:59
  assert.equal(isDaytime('2026-11-20T14:29:00Z', 'Asia/Kolkata'), true);  // 19:59
  assert.equal(isDaytime('2026-11-20T14:30:00Z', 'Asia/Kolkata'), false); // 20:00
  // The sender's page keeps its shape and now names the time and the zone.
  assert.match(deadlineLine(new Date(Date.now() + 12 * 864e5).toISOString()), /^Closes on \d{1,2} \w+ \d{4} at \d\d:\d\d .*(UTC|time \(UTC.*\)), in 12 days$/);
});

test('emails give a deadline with its time in UTC, and in the signer\'s own zone as well once it is known', async () => {
  const c = await signUp('Dee Sender', 'dee-deadline@example.com', ip());
  const e = await sendTo(c, [{ name: 'Ravi Later', email: 'ravi-deadline@example.com' }], { expire_days: 30 });
  const closes = (await c.get(`/envelopes/${e.id}`)).data.envelope.expires_at;
  const first = mailTo('ravi-deadline@example.com').pop()!;
  assert.ok(first.html.includes(`This request closes on ${momentText(closes)}.`), 'the invitation names the time and says UTC');
  assert.ok(!first.html.includes(`closes on ${closes.slice(0, 10)}`), 'and no longer a bare day');
  // Ravi opens it in India. From then on his emails name the same moment by his clock too.
  const rc = new Client(), tok = tokenFor(e.id, 'ravi-deadline@example.com');
  assert.equal((await rc.post(`/sign/${tok}/consent`, { tz: 'Asia/Kolkata' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e.id}/remind`)).data.reminded, 1);
  const reminder = mailTo('ravi-deadline@example.com').pop()!;
  assert.match(reminder.subject, /^Reminder: /);
  assert.ok(reminder.html.includes(`This request closes on ${momentText(closes)}, which is ${momentText(closes, 'Asia/Kolkata')}.`), reminder.html.slice(-900));
  // The signing page is given the moment itself and words it in the device's zone (momentText, tested above).
  assert.equal((await rc.get(`/sign/${tok}`)).data.envelope.expires_at, closes);
  // More time: the audit line names the new moment, not only its day.
  const later = (await c.post(`/envelopes/${e.id}/extend`, { days: 10 })).data.expires_at;
  const line = (await c.get(`/envelopes/${e.id}`)).data.audit.find((a: any) => a.action === 'Deadline extended');
  assert.equal(line.detail, `New deadline ${momentText(later)}`);
});

test('the warning three days before a deadline names the moment, to the sender in their own zone and to the signer', async () => {
  const c = await signUp('Wes Warned', 'wes-warned@example.com', ip());
  assert.equal((await c.call('GET', '/me', undefined, { 'x-tz': 'Asia/Kolkata' })).status, 200);
  const e = await sendTo(c, [{ name: 'Lia Late', email: 'lia-late@example.com' }], { expire_days: 30, reminder_days: 0 });
  // Ten days out, two days left: the timer sends the one warning.
  const closes = new Date(Date.now() + 2 * 864e5).toISOString();
  s.db.run('UPDATE envelopes SET sent_at=?, expires_at=?, expiry_warned_at=NULL WHERE id=?', new Date(Date.now() - 10 * 864e5).toISOString(), closes, e.id);
  await s.env.cronTick();
  const toSender = mailTo('wes-warned@example.com').filter((m: any) => m.subject.startsWith('Expires soon: '));
  assert.equal(toSender.length, 1);
  assert.ok(toSender[0].html.includes(`It closes on ${momentForEmail(closes, 'Asia/Kolkata')}.`), toSender[0].html.slice(0, 1200));
  const toSigner = mailTo('lia-late@example.com').filter((m: any) => m.html.includes('ask Wes Warned for more time'));
  assert.equal(toSigner.length, 1);
  assert.ok(toSigner[0].html.includes(`This request closes on ${momentText(closes)}.`));
});

test('the sender\'s Give more time dialog gives the new deadline with its time and zone, never a bare day', () => {
  const at = '2027-03-20T16:40:00.000Z';
  assert.equal(closingText(at), momentText(at, deviceZone()));
  assert.match(closingText(at), / at \d\d:\d\d /);
  assert.equal(closingText(null), '');
  assert.equal(closingText('soon'), '');
  // The dialog words both the preview and the message after saving this way.
  const src = fs.readFileSync('src/components/sender/dialogs.tsx', 'utf8');
  const dialog = src.slice(src.indexOf('export function ExtendDialog'), src.indexOf('export function', src.indexOf('export function ExtendDialog') + 10));
  assert.ok(!/longDate\(/.test(dialog), 'no bare day');
  assert.equal(dialog.match(/closingText\(/g)?.length, 3);
});

test('an automatic reminder waits for the morning of a signer whose time zone we know, and goes out at once to everyone else', async () => {
  const c = await signUp('Remi Sender', 'remi-night@example.com', ip());
  const night = zoneWhereItIs(2), day = zoneWhereItIs(13);
  const e = await sendTo(c, [{ name: 'Nia Night', email: 'nia-night@example.com' }, { name: 'Dev Day', email: 'dev-day@example.com' }, { name: 'Una Unknown', email: 'una-unknown@example.com' }], { reminder_days: 1 });
  for (const [email, tz] of [['nia-night@example.com', night], ['dev-day@example.com', day]])
    assert.equal((await new Client().post(`/sign/${tokenFor(e.id, email)}/consent`, { tz })).status, 200);
  const reminders = (email: string) => mailTo(email).filter((m: any) => m.subject.startsWith('Reminder: ')).length;
  // Two days pass.
  s.db.run('UPDATE envelopes SET sent_at=?, last_reminder_at=NULL WHERE id=?', new Date(Date.now() - 2 * 864e5).toISOString(), e.id);
  s.db.run('UPDATE recipients SET sent_at=? WHERE envelope_id=?', new Date(Date.now() - 2 * 864e5).toISOString(), e.id);
  await s.env.cronTick();
  assert.equal(reminders('dev-day@example.com'), 1, 'it is day for Dev');
  assert.equal(reminders('una-unknown@example.com'), 1, 'nothing is known about Una, so as before');
  assert.equal(reminders('nia-night@example.com'), 0, 'it is two in the morning for Nia');
  const held = s.db.get("SELECT reminder_held_at h FROM recipients WHERE envelope_id=? AND email='nia-night@example.com'", e.id).h;
  assert.ok(held);
  let audit = (await c.get(`/envelopes/${e.id}`)).data.audit;
  assert.equal(audit.find((a: any) => a.action === 'Reminder waits for the morning').detail, `Nia Night (${night}): it is night where they are, so the reminder goes out at 8:00 their time.`);
  // The next runs of the timer during her night change nothing, and nobody is reminded twice.
  await s.env.cronTick();
  assert.deepEqual([reminders('nia-night@example.com'), reminders('dev-day@example.com'), reminders('una-unknown@example.com')], [0, 1, 1]);
  // Morning comes for Nia (her clock is moved, since the test cannot wait): the reminder goes out, once.
  s.db.run("UPDATE recipients SET tz=? WHERE envelope_id=? AND email='nia-night@example.com'", zoneWhereItIs(9), e.id);
  await s.env.cronTick();
  await s.env.cronTick();
  assert.equal(reminders('nia-night@example.com'), 1);
  assert.equal(s.db.get("SELECT reminder_held_at h FROM recipients WHERE envelope_id=? AND email='nia-night@example.com'", e.id).h, null);
  audit = (await c.get(`/envelopes/${e.id}`)).data.audit;
  assert.ok(audit.some((a: any) => a.action === 'Reminder sent' && /^Nia Night, once it was morning where they are/.test(a.detail)));
  // A reminder the sender asks for by hand is not held: it goes out now, night or not.
  s.db.run("UPDATE recipients SET tz=? WHERE envelope_id=? AND email='nia-night@example.com'", night, e.id);
  assert.equal((await c.post(`/envelopes/${e.id}/remind`, { recipient_id: e.recipients.find((r: any) => r.email === 'nia-night@example.com').id })).data.reminded, 1);
  assert.equal(reminders('nia-night@example.com'), 2);
});

// ---- F. Names ----------------------------------------------------------------------------------------

test('a signer can fix the spacing, a hyphen or a dot of their own name, and a name in another script goes to the sender as "may be the same name"', async () => {
  const c = await signUp('Hana Sender', 'hana-names@example.com', ip());
  const e = await sendTo(c, [
    { name: '山田 太郎', email: 'yamada-name@example.com' }, { name: 'Mary-Ann Okafor', email: 'maryann@example.com' }, { name: 'J.R. Tolkien', email: 'jrr@example.com' },
    { name: 'Иван Петров', email: 'ivan-name@example.com' }, { name: '田中 花子', email: 'tanaka@example.com' }, { name: 'Ana Lima', email: 'ana-name@example.com' },
  ]);
  const rename = (email: string, name: string) => new Client().post(`/sign/${tokenFor(e.id, email)}/name`, { name });
  const nameOf = (email: string) => s.db.get('SELECT name FROM recipients WHERE envelope_id=? AND email=?', e.id, email).name;
  // The same letters with only what stands between them changed: done at once.
  for (const [email, to] of [['yamada-name@example.com', '山田太郎'], ['maryann@example.com', 'Mary Ann Okafor'], ['jrr@example.com', 'JR Tolkien']]) {
    const r = await rename(email, to);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.applied, true, `${to}: ${r.data.message}`);
    assert.equal(nameOf(email), to);
  }
  // Cyrillic to Latin, and kanji to Latin: not changed by us, the sender is asked, and nobody is told it is a
  // different name, because it may not be.
  for (const [email, was, to] of [['ivan-name@example.com', 'Иван Петров', 'Ivan Petrov'], ['tanaka@example.com', '田中 花子', 'Hanako Tanaka']]) {
    const r = await rename(email, to);
    assert.equal(r.data.applied, false);
    assert.match(r.data.message, /This may be the same name in another script, but software cannot tell, so we asked Hana Sender to confirm it\./);
    assert.ok(!/different name|more than|not yours/.test(r.data.message), r.data.message);
    assert.equal(nameOf(email), was, 'the name stays as the sender wrote it until they decide');
    const mail = mailTo('hana-names@example.com').filter((m: any) => m.subject.startsWith('Name change asked for')).pop()!;
    assert.ok(mail.html.includes(`asked for the name on the document to be &quot;${to}&quot;`) || mail.html.includes(`asked for the name on the document to be "${to}"`), mail.html.slice(0, 900));
    assert.match(mail.html, /It may be the same name in another script, which software cannot tell/);
  }
  const trail = (await c.get(`/envelopes/${e.id}`)).data.audit;
  assert.equal(trail.filter((a: any) => a.action === 'Signer corrected their name').length, 3);
  assert.equal(trail.filter((a: any) => a.action === 'Name change asked for' && /in a different script from/.test(a.detail)).length, 2);
  // A different name in the same script is still passed to the sender in the words for that, as before.
  const other = await rename('ana-name@example.com', 'Bo Stone');
  assert.equal(other.data.applied, false);
  assert.ok(!/another script/.test(other.data.message));
  assert.equal(nameOf('ana-name@example.com'), 'Ana Lima');
});

test('nobody is greeted by a guessed first name, and a new workspace is named after the whole name', async () => {
  // In "山田 太郎" the first word is the family name, and "Sukarno" has only one.
  const c = await signUp('山田 太郎', 'taro-ws@example.com', ip());
  assert.equal((await c.get('/me')).data.account.name, "山田 太郎's workspace");
  const d = await signUp('Sukarno', 'sukarno-ws@example.com', ip());
  assert.equal((await d.get('/me')).data.account.name, "Sukarno's workspace");
  // The screens and share texts that used to cut a name at its first space no longer do. The one place left that
  // shows a first word on purpose is the help desk, which gives customers an operator's first name and no more.
  const cut = /\.split\((?:' '|" "|\/\\s\+\/)\)\[0\]/;
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? files(path.join(dir, x.name)) : /\.tsx?$/.test(x.name) ? [path.join(dir, x.name)] : []));
  const found = files('src').filter((f) => !/routes-billing|credits\.ts$|lib\/support\.ts$/.test(f)).filter((f) => fs.readFileSync(f, 'utf8').split('\n').some((line) => cut.test(line) && /name/i.test(line)));
  assert.deepEqual(found, []);
});

// ---- Repairs after the skeptic's report (verify:nonus) -------------------------------------------------

test('a time zone belongs to its person: a hand-over, a correction to another person or a hand-back to the group starts without it', async () => {
  const c = await signUp('Tia Sender', 'tia-zones@example.com', ip());
  const far = otherDayZone();
  const zoneOf = (id: string) => s.db.get('SELECT tz, reminder_held_at h FROM recipients WHERE id=?', id);
  // 1. Passed on by the signer. Bob's device says nothing, so his date is the UTC day (the sender's zone is unknown).
  const e = await sendTo(c, [{ name: 'Aiko Far', email: 'aiko-tz@example.com', type: 'date_signed' }], { date_format: 'D MMM YYYY', reminder_days: 1 });
  const rid = e.recipients[0].id;
  const a = new Client(), tok = tokenFor(e.id, 'aiko-tz@example.com');
  assert.equal((await a.post(`/sign/${tok}/consent`, { tz: far })).status, 200);
  s.db.run('UPDATE recipients SET reminder_held_at=? WHERE id=?', new Date().toISOString(), rid);
  assert.equal((await a.post(`/sign/${tok}/reassign`, { name: 'Bob Elsewhere', email: 'bob-tz@example.com', reason: 'He signs' })).status, 200);
  assert.deepEqual(zoneOf(rid), { tz: null, h: null });
  assert.equal((await signAll(e.id, 'bob-tz@example.com')).status, 200);
  const done = s.db.get('SELECT tz, completed_at FROM recipients WHERE id=?', rid);
  assert.equal(done.tz, null);
  assert.notEqual(formatDate(done.completed_at, 'D MMM YYYY', far), formatDate(done.completed_at, 'D MMM YYYY'), 'the test only means something when the two days differ');
  const pages = await extractPages((await c.get(`/envelopes/${e.id}/download`)).data);
  assert.ok(pages[0].includes(formatDate(done.completed_at, 'D MMM YYYY')), pages[0]);
  assert.ok(!pages[0].includes(formatDate(done.completed_at, 'D MMM YYYY', far)));
  const cert = pages.slice(1).join(' ');
  assert.ok(!/Bob Elsewhere[\s\S]{0,900}Time zone [^,]+, as reported by their device/.test(cert), 'Aiko\'s zone is not printed as Bob\'s device');
  assert.ok(!/Bob Elsewhere <bob-tz@example\.com> · [^·]+ · [0-9a-f]{16} · their time/.test(cert));

  // 2. The sender corrects to another person (POST /correct): the new person's invitation names UTC only.
  const e2 = await sendTo(c, [{ name: 'Old Person', email: 'old-tz@example.com' }], { expire_days: 30 });
  const r2 = e2.recipients[0].id;
  assert.equal((await new Client().post(`/sign/${tokenFor(e2.id, 'old-tz@example.com')}/consent`, { tz: 'Asia/Tokyo' })).status, 200);
  assert.equal(zoneOf(r2).tz, 'Asia/Tokyo');
  assert.equal((await c.post(`/envelopes/${e2.id}/correct`, { recipient_id: r2, name: 'New Person', email: 'new-tz@example.com' })).status, 200);
  assert.equal(zoneOf(r2).tz, null);
  const inv = mailTo('new-tz@example.com').pop()!;
  assert.ok(inv && !/Asia\/Tokyo/.test(inv.html), 'the new person is not told the deadline in the old person\'s zone');

  // 3. The same inbox under another name is another person too; a spelling fix of the same person keeps the zone.
  const e3 = await sendTo(c, [{ name: 'Kim Shared', email: 'shared-tz@example.com' }]);
  const r3 = e3.recipients[0].id;
  assert.equal((await new Client().post(`/sign/${tokenFor(e3.id, 'shared-tz@example.com')}/consent`, { tz: 'Europe/Berlin' })).status, 200);
  assert.equal((await c.post(`/envelopes/${e3.id}/correct`, { recipient_id: r3, name: 'Kim Sharred', email: 'shared-tz@example.com' })).status, 200);
  assert.equal(zoneOf(r3).tz, 'Europe/Berlin', 'a spelling fix is the same person');
  assert.equal((await c.post(`/envelopes/${e3.id}/correct`, { recipient_id: r3, name: 'Lee Partner', email: 'shared-tz@example.com' })).status, 200);
  assert.equal(zoneOf(r3).tz, null);

  // 4. A correction by editing the envelope (PUT) that puts another address in the place.
  const e4 = await sendTo(c, [{ name: 'Put Person', email: 'put-tz@example.com' }]);
  const r4 = e4.recipients[0].id;
  assert.equal((await new Client().post(`/sign/${tokenFor(e4.id, 'put-tz@example.com')}/consent`, { tz: 'America/Lima' })).status, 200);
  const cur = (await c.get(`/envelopes/${e4.id}`)).data.envelope;
  const put = await c.put(`/envelopes/${e4.id}`, { subject: cur.subject, documents: cur.documents.map((d: any) => ({ id: d.id, file_id: d.file_id, name: d.name })), recipients: cur.recipients.map((r: any) => ({ id: r.id, role: r.role, name: 'Other Person', email: 'other-put-tz@example.com' })), fields: cur.fields, edit_version: cur.edit_version });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(zoneOf(r4).tz, null);

  // 5. A member of a group hands the document back: the next member reports their own zone.
  const members = [{ name: 'Maya Group', email: 'maya-tz@hr.example' }, { name: 'Ben Group', email: 'ben-tz@hr.example' }];
  const g = (await c.post('/groups', { name: 'Zone team', members })).data.group;
  const file = await upload(c, 1);
  const ge = (await c.post('/envelopes', { subject: 'Group zone', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'g', role: 'signer', group_id: g.id }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'g', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }], send: true })).data.envelope;
  const mayaLink = s.db.get('SELECT token FROM recipient_members WHERE envelope_id=? AND email=?', ge.id, 'maya-tz@hr.example').token;
  assert.equal((await new Client().post(`/sign/${mayaLink}/consent`, { tz: 'Africa/Nairobi' })).status, 200);
  const grow = () => s.db.get('SELECT tz FROM recipients WHERE envelope_id=? AND group_name IS NOT NULL', ge.id);
  assert.equal(grow().tz, 'Africa/Nairobi');
  assert.equal((await new Client().post(`/sign/${mayaLink}/hand-back`, {})).status, 200);
  assert.equal(grow().tz, null);
});

test('a signing link that reports a new time zone again and again writes one line, and one more at Finish if the zone changed', async () => {
  const c = await signUp('Flo Sender', 'flo-zones@example.com', ip());
  const e = await sendTo(c, [{ name: 'Flood Signer', email: 'flood-tz@example.com', type: 'date_signed' }], { date_format: 'D MMM YYYY' });
  const tok = tokenFor(e.id, 'flood-tz@example.com');
  const lines = () => s.db.all("SELECT detail FROM audit WHERE envelope_id=? AND action='Time zone reported' ORDER BY seq", e.id).map((a: any) => a.detail);
  const f = new Client();
  for (let i = 0; i < 60; i++) assert.equal((await f.post(`/sign/${tok}/consent`, { tz: i % 2 ? 'Europe/Berlin' : 'Asia/Tokyo' })).status, 200);
  const g = new Client();
  g.ip = '203.0.113.78';
  for (let i = 0; i < 20; i++) await g.post(`/sign/${tok}/consent`, { tz: i % 2 ? 'Europe/Berlin' : 'Asia/Tokyo' });
  assert.equal(lines().length, 1, 'only the first report is written while the link is used');
  assert.match(lines()[0], /^Flood Signer: Asia\/Tokyo \(/);
  // The zone is still kept: the last one reported decides the day. It is Berlin now, so Finish says so once.
  assert.equal(s.db.get('SELECT tz FROM recipients WHERE envelope_id=?', e.id).tz, 'Europe/Berlin');
  const v = (await f.get(`/sign/${tok}`)).data;
  const values = Object.fromEntries(v.fields.map((x: any) => [x.id, x.type === 'text' ? 'ok' : '1']));
  // A Finish from a device that says nothing still puts the zone the date rests on into the record.
  assert.equal((await f.post(`/sign/${tok}/complete`, { values, signature_png: PNG, initials_png: PNG })).status, 200);
  assert.equal(lines().length, 2);
  assert.match(lines()[1], /^Flood Signer: Europe\/Berlin \(UTC[+-]\d\d:\d\d at this moment\), as their device says when they finished\./);
  const pages = await extractPages((await c.get(`/envelopes/${e.id}/download`)).data);
  assert.ok(pages.length <= 3, `the certificate stays short: ${pages.length} pages`);
  const done = s.db.get('SELECT completed_at FROM recipients WHERE envelope_id=?', e.id).completed_at;
  assert.ok(pages[0].includes(formatDate(done, 'D MMM YYYY', 'Europe/Berlin')));
  // Same zone at Finish as on record: no second line (the earlier test checks one consent and one Finish).
  assert.equal((await c.get(`/envelopes/${e.id}`)).data.chain.ok, true);
});
