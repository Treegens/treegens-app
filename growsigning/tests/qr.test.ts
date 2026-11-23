// QR codes made by the product itself (src/lib/qr.ts), and the places that show one.
// A wrong QR code looks exactly like a right one, so the encoder is held to three things here:
//  1. Fixed examples. Every matrix below was read from rendered pixels by jsQR (all of them) and by OpenCV (all of
//     the small ones: OpenCV does not find some codes of version 21 and up, and never read one wrongly), and is
//     module for module what the reference encoder of Project Nayuki makes for the same bytes. Those tools were
//     installed outside the project for that check and are not a dependency.
//  2. A reader written apart from the encoder. It reads every version back the way a decoder does: format bits,
//     mask off, codewords out of the zigzag, blocks apart, Reed-Solomon checked, text out. Its tables are typed
//     from ISO/IEC 18004 and not taken from the encoder.
//  3. The fixed parts of the picture: finders, separators, timing lines, alignment squares, the dark module.
// Then the picture as SVG, the checks on a link, the words on the screens, and what the server and pages do.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { boot, Client, signUp, simple, draft, tokenFor, PNG, type Server } from './helpers.ts';
import { qrEncode, qrSvg, qrCapacity, qrSize, qrAlignment, qrPenalty, QrTooLong, QR_MAX_BYTES, QR_QUIET, type Qr } from '../src/lib/qr.ts';
import * as words from '../src/lib/qrlink.ts';
import { qrForLink, qrReach, QR_LINK_MAX, QR_SHOW_SECONDS, personScanLine, personCodeWarning, afterScanLine, hiddenLine, formCodeWarning, qrFileName, FORM_SCAN_LINE, FORM_LINK_LINE, FORM_PAUSED_LINE, OWN_PHONE_LINE, SCAN_TROUBLE } from '../src/lib/qrlink.ts';
import { englishIf } from './words.ts';

let db: Server['db'];
before(async () => {
  ({ db } = await boot());
});

// Screens moved into the catalogue are read with their English put back (lang-sender-rest, tests/words.ts).
const read = (p: string) => englishIf(p, fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const rowsOf = (q: Qr) => q.modules.map((r) => r.map((on) => (on ? '#' : '.')).join(''));
const hash = (q: Qr) => crypto.createHash('sha256').update(q.modules.map((r) => r.map((on) => (on ? '1' : '0')).join('')).join('\n')).digest('hex').slice(0, 16);
const FILL = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_';
/** A link that fills version v to the last byte. */
const textFor = (v: number) => ('https://sign.example.org/sign/' + FILL.repeat(70)).slice(0, qrCapacity(v));

// ---- Tables typed from the standard --------------------------------------------------------------------------------

// Table 7: bytes a code holds in byte mode at level M, versions 1 to 40.
const CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331];
// Table E.1: centres of the alignment squares. Place 0 is not used.
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]];
// Table 9, level M: error correction codewords in a block, then how many blocks of how many data codewords, in two
// groups. Place 0 is not used.
const BLOCKS_M: [number, number, number, number, number][] = [[0, 0, 0, 0, 0],
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42], [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
  [26, 17, 42, 0, 0], [28, 17, 46, 0, 0], [28, 4, 47, 14, 48], [28, 6, 45, 14, 46], [28, 8, 47, 13, 48], [28, 19, 46, 4, 47], [28, 22, 45, 3, 46], [28, 3, 45, 23, 46], [28, 21, 45, 7, 46], [28, 19, 47, 10, 48],
  [28, 2, 46, 29, 47], [28, 10, 46, 23, 47], [28, 14, 46, 21, 47], [28, 14, 46, 23, 47], [28, 12, 47, 26, 48], [28, 6, 47, 34, 48], [28, 29, 46, 14, 47], [28, 13, 46, 32, 47], [28, 40, 47, 7, 48], [28, 18, 47, 31, 48]];
// Table 1: bits left over after the last codeword.
const REMAINDER = (v: number) => (v === 1 ? 0 : v <= 6 ? 7 : v <= 13 ? 0 : v <= 20 ? 3 : v <= 27 ? 4 : v <= 34 ? 3 : 0);
// Table C.1: the 15 format bits as drawn, for level M and masks 0 to 7.
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
// Table D.1: the 18 version bits, for the versions the standard is usually quoted for.
const VERSION_BITS: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 20: 0x149a6, 32: 0x209d5, 40: 0x28c69 };

// ---- A reader written apart from the encoder -----------------------------------------------------------------------

// Multiplying in GF(256) the slow way, with no tables: x^8 + x^4 + x^3 + x^2 + 1.
const gmul = (a: number, b: number) => {
  let p = 0;
  for (; b; b >>= 1) {
    if (b & 1) p ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }
  return p;
};
// The mask conditions as table 10 writes them: i is the row and j the column.
const MASK_OFF: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (_i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

/** Which modules never carry data, for a version. */
function fixedMap(version: number) {
  const size = 17 + 4 * version;
  const A = ALIGN[version];
  const far = A[A.length - 1];
  return (row: number, col: number) => {
    if (row === 6 || col === 6) return true; // timing lines
    if (row <= 8 && col <= 8) return true; // top left finder, its separator, format bits
    if (row <= 8 && col >= size - 8) return true; // top right
    if (row >= size - 8 && col <= 8) return true; // bottom left, with the dark module
    if (version >= 7 && ((row <= 5 && col >= size - 11) || (col <= 5 && row >= size - 11))) return true; // version bits
    for (const r of A) for (const c of A) {
      if ((r === 6 && c === 6) || (r === 6 && c === far) || (r === far && c === 6)) continue;
      if (Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2) return true;
    }
    return false;
  };
}

function readQr(m: boolean[][]) {
  const size = m.length;
  assert.ok(m.every((r) => r.length === size), 'the code is square');
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 40, `a side of ${size} is no version`);
  const bit = (row: number, col: number) => (m[row][col] ? 1 : 0);

  // The format bits, twice: around the top left finder, and split between the top right and the bottom left.
  let one = 0;
  let two = 0;
  for (let i = 0; i < 15; i++) {
    one |= (i <= 5 ? bit(i, 8) : i === 6 ? bit(7, 8) : i === 7 ? bit(8, 8) : i === 8 ? bit(8, 7) : bit(8, 14 - i)) << i;
    two |= (i <= 7 ? bit(8, size - 1 - i) : bit(size - 15 + i, 8)) << i;
  }
  assert.equal(one, two, 'both copies of the format bits say the same');
  const format = one ^ 0b101010000010010;
  let rem = format;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0b10100110111 << (i - 10);
  assert.equal(rem, 0, 'the format bits are a word of their code: nothing is left when divided by its generator');
  const level = format >> 13;
  const mask = (format >> 10) & 7;
  assert.equal(m[size - 8][8], true, 'the dark module is dark');

  // From version 7 the version is written twice as well.
  if (version >= 7) {
    let low = 0;
    let high = 0;
    for (let i = 0; i < 18; i++) {
      low |= bit(size - 11 + (i % 3), Math.floor(i / 3)) << i;
      high |= bit(Math.floor(i / 3), size - 11 + (i % 3)) << i;
    }
    assert.equal(low, high, 'both copies of the version bits say the same');
    let r = low;
    for (let i = 17; i >= 12; i--) if (r & (1 << i)) r ^= 0b1111100100101 << (i - 12);
    assert.equal(r, 0, 'the version bits are a word of their code');
    assert.equal(low >> 12, version, 'the version bits name the version the size has');
    if (VERSION_BITS[version]) assert.equal(low, VERSION_BITS[version], `the version bits of version ${version} are the ones the standard prints`);
  }

  // Data: up the two rightmost columns, down the next two, and so on, never on a fixed module, never in column 6.
  const fixed = fixedMap(version);
  const bits: number[] = [];
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k;
      for (const c of [col, col - 1]) if (!fixed(row, c)) bits.push(bit(row, c) ^ (MASK_OFF[mask](row, c) ? 1 : 0));
    }
    up = !up;
  }
  const [ec, n1, d1, n2, d2] = BLOCKS_M[version];
  const total = n1 * (d1 + ec) + n2 * (d2 + ec);
  assert.equal(bits.length, total * 8 + REMAINDER(version), `version ${version} has room for ${total} codewords and ${REMAINDER(version)} bits over`);
  assert.ok(bits.slice(total * 8).every((b) => b === 0), 'the bits left over are light before the mask');
  const cw = Array.from({ length: total }, (_, k) => bits.slice(k * 8, k * 8 + 8).reduce((n, b) => (n << 1) | b, 0));

  // The codewords were dealt out block by block. Put each block back together and check it.
  const blocks = Array.from({ length: n1 + n2 }, (_, b) => ({ want: b < n1 ? d1 : d2, d: [] as number[], e: [] as number[] }));
  let k = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.want) b.d.push(cw[k++]);
  for (let i = 0; i < ec; i++) for (const b of blocks) b.e.push(cw[k++]);
  assert.equal(k, total);
  for (const b of blocks) {
    // A block without errors, read as a polynomial, is zero at 2^0, 2^1, ... one for each error correction codeword.
    for (let j = 0, x = 1; j < ec; j++, x = gmul(x, 2)) assert.equal([...b.d, ...b.e].reduce((s, c) => gmul(s, x) ^ c, 0), 0, `a block of version ${version} fails its Reed-Solomon check at root ${j}`);
  }

  // The message: byte mode, a length, the bytes, an end mark, then filler.
  const data = blocks.flatMap((b) => b.d);
  const stream = data.flatMap((c) => Array.from({ length: 8 }, (_, i) => (c >> (7 - i)) & 1));
  let at = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | stream[at++];
    return v;
  };
  assert.equal(take(4), 0b0100, 'byte mode');
  const count = take(version <= 9 ? 8 : 16);
  const bytes = Array.from({ length: count }, () => take(8));
  const end = Math.min(4, stream.length - at);
  assert.equal(take(end), 0, 'the end mark is zeros');
  while (at % 8) assert.equal(take(1), 0, 'zeros up to a whole byte');
  for (let i = 0; at < stream.length; i++) assert.equal(take(8), i % 2 ? 0x11 : 0xec, 'the filler bytes take turns');
  return { version, level, mask, bytes, text: Buffer.from(bytes).toString('utf8') };
}

// ---- 1. The encoder is right ---------------------------------------------------------------------------------------

test('size, capacity and the choice of version follow the tables of the standard', () => {
  for (let v = 1; v <= 40; v++) {
    assert.equal(qrSize(v), 17 + 4 * v);
    assert.equal(qrCapacity(v), CAPACITY_M[v - 1], `version ${v}`);
    assert.deepEqual(qrAlignment(v), ALIGN[v], `alignment centres of version ${v}`);
    // The smallest version that holds the text is used: full to the last byte stays, one byte more moves up.
    const full = qrEncode('x'.repeat(CAPACITY_M[v - 1]));
    assert.equal(full.version, v);
    assert.equal(full.size, 17 + 4 * v);
    assert.equal(full.modules.length, full.size);
    assert.ok(full.modules.every((r) => r.length === full.size && r.every((on) => typeof on === 'boolean')));
    if (v < 40) assert.equal(qrEncode('x'.repeat(CAPACITY_M[v - 1] + 1)).version, v + 1);
  }
  assert.equal(QR_MAX_BYTES, CAPACITY_M[39]);
  assert.equal(qrEncode('').version, 1, 'nothing at all is still a code, the smallest');
  // Length is counted in bytes, not characters: 14 two-byte letters need the second version.
  assert.equal(qrEncode('é'.repeat(7)).version, 1);
  assert.equal(qrEncode('é'.repeat(8)).version, 2);
  // A link of 300 plain characters, the longest a screen makes a code for, fits version 13.
  assert.equal(qrEncode(`https://sign.example.org/${'a'.repeat(275)}`).version, 13);
});

const FINDER = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
const ALIGNMENT = ['#####', '#...#', '#.#.#', '#...#', '#####'];

function checkFixedParts(q: Qr) {
  const { size, modules: m, version } = q;
  const tag = `version ${version}, mask ${q.mask}`;
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]])
    FINDER.forEach((row, dy) => assert.equal(m[top + dy].slice(left, left + 7).map((on) => (on ? '#' : '.')).join(''), row, `finder at ${top},${left}, ${tag}`));
  // A light separator, one module wide, between each finder and the rest.
  for (let i = 0; i < 8; i++) {
    for (const [row, col] of [[7, i], [i, 7], [7, size - 1 - i], [i, size - 8], [size - 8, i], [size - 1 - i, 7]]) assert.equal(m[row][col], false, `separator at ${row},${col}, ${tag}`);
  }
  // Timing lines between the finders: dark on even places.
  for (let i = 8; i <= size - 9; i++) {
    assert.equal(m[6][i], i % 2 === 0, `timing row at ${i}, ${tag}`);
    assert.equal(m[i][6], i % 2 === 0, `timing column at ${i}, ${tag}`);
  }
  const A = ALIGN[version];
  const far = A[A.length - 1];
  let squares = 0;
  for (const r of A) for (const c of A) {
    if ((r === 6 && c === 6) || (r === 6 && c === far) || (r === far && c === 6)) continue;
    squares++;
    ALIGNMENT.forEach((row, dy) => assert.equal(m[r - 2 + dy].slice(c - 2, c + 3).map((on) => (on ? '#' : '.')).join(''), row, `alignment square at ${r},${c}, ${tag}`));
  }
  assert.equal(squares, version === 1 ? 0 : A.length * A.length - 3);
  assert.equal(m[size - 8][8], true, `the dark module, ${tag}`);
}

test('every version has its finders, separators, timing lines, alignment squares and dark module in place', () => {
  for (let v = 1; v <= 40; v++) {
    checkFixedParts(qrEncode(textFor(v)));
    // The fixed parts do not move with the mask.
    if (v === 1 || v === 7 || v === 14 || v === 40) for (let mask = 0; mask < 8; mask++) checkFixedParts(qrEncode(textFor(v), { mask }));
  }
});

test('the format bits are the ones the standard prints for level M and each mask', () => {
  for (const v of [1, 2, 6, 7, 13, 27, 40]) for (let mask = 0; mask < 8; mask++) {
    const q = qrEncode(textFor(v), { mask });
    assert.equal(q.mask, mask);
    const { size, modules: m } = q;
    // Bit 14 first, as the table prints them: across row 8 from the left, then up column 8.
    const drawn = [m[8][0], m[8][1], m[8][2], m[8][3], m[8][4], m[8][5], m[8][7], m[8][8], m[7][8], m[5][8], m[4][8], m[3][8], m[2][8], m[1][8], m[0][8]].map((on) => (on ? '1' : '0')).join('');
    assert.equal(drawn, FORMAT_M[mask], `version ${v}, mask ${mask}`);
    // And again: up column 8 from the bottom, then across row 8 to the right edge.
    const again = [...Array.from({ length: 7 }, (_, i) => m[size - 1 - i][8]), ...Array.from({ length: 8 }, (_, i) => m[8][size - 8 + i])].map((on) => (on ? '1' : '0')).join('');
    assert.equal(again, FORMAT_M[mask], `second copy, version ${v}, mask ${mask}`);
    const back = readQr(m);
    assert.equal(back.level, 0b00, 'level M is written as 00');
    assert.equal(back.mask, mask);
  }
});

test('every version from 1 to 40 reads back, byte for byte, with a reader written apart from the encoder', () => {
  for (let v = 1; v <= 40; v++) {
    // Full to the last byte (no room for an end mark), the least that needs this version, and one in between.
    const least = v === 1 ? 'a' : 'x'.repeat(CAPACITY_M[v - 2] + 1);
    for (const text of [textFor(v), least, textFor(v).slice(0, CAPACITY_M[v - 1] - 3)]) {
      const q = qrEncode(text);
      assert.equal(q.version, v);
      const back = readQr(q.modules);
      assert.equal(back.version, v);
      assert.equal(back.mask, q.mask);
      assert.equal(back.text, text, `version ${v} gives its text back`);
    }
  }
  // Every mask on a small, a middle and a large code.
  for (const v of [1, 5, 9, 10, 22, 40]) for (let mask = 0; mask < 8; mask++) assert.equal(readQr(qrEncode(textFor(v), { mask }).modules).text, textFor(v), `version ${v}, mask ${mask}`);
});

test('odd characters go in as UTF-8 and come back unchanged', () => {
  const odd = ['', ' ', 'A', '0123456789', 'https://example.org/f/naïve-café', 'https://example.org/f/日本語のフォーム', 'https://пример.рф/ф/форма', 'https://example.org/f/😀🌳?q=ß&x=€',
    'https://example.org/f/"><script>alert(1)</script>', "https://example.org/f/' OR 1=1 --", 'https://example.org/f/a%20b%2Fc', 'https://example.org/f/<svg onload=x>', 'https://example.org/f/&amp;&lt;',
    'https://example.org/\\back\\slash', 'https://example.org/f/tab\there', 'https://example.org/f/line\nbreak', 'https://example.org/f/مرحبا', 'https://example.org/f/שלום', 'https://example.org/f/ไทย', 'https://example.org/f/한국어',
    'mailto:someone@example.org?subject=Hello%20there', 'https://example.org/f/~tilde`tick^caret|pipe{brace}', '\u0000\u0001\u007f', 'https://example.org/' + '😀'.repeat(280)];
  for (const text of odd) {
    const back = readQr(qrEncode(text).modules);
    assert.equal(back.text, text);
    assert.deepEqual(back.bytes, [...new TextEncoder().encode(text)]);
  }
});

// Each of these was decoded from pixels by the outside decoders and matches the reference encoder module for module.
// The pair is the mask that was chosen and the first 16 hex digits of the SHA-256 of the matrix.
const PER_VERSION: [number, string][] = [[2, '13cd0fbfa0e11b15'], [6, '17cfc716949d70ff'], [1, '8d0fcb530c0de3ef'], [6, '82adca7c09e04cd5'], [4, 'd0debf43cfebafcc'], [3, '70845642b254bb27'], [2, 'c087f584ef6c3c31'], [2, '46b18b3b9ddf0c68'],
  [2, 'bc981a0e62118b87'], [4, '5e9f5f29ef645aed'], [6, '2a7ba21c9939a4f6'], [2, '679d8a3c6a89dbdd'], [2, '7680f8993badd3ce'], [2, 'c9e677ba7905e49d'], [4, 'b5b54d4a114b532f'], [2, '7349ea9cf3651979'],
  [2, '8827584d1fc6d725'], [5, '311acf68495bad96'], [2, 'feaa07c08278dcad'], [2, '8b72aabc24c2dc1c'], [4, '3323b37dbce575af'], [2, 'f77b40e9d28540fc'], [4, 'de6a4e0f19fa296b'], [3, '614a97edd4b84b48'],
  [2, '5ff70e79d0ce67e0'], [4, '3a71c93c2264f0ab'], [4, 'f8c9d66bc44259df'], [2, '48567d36c4925293'], [4, '6279992338a9e157'], [2, 'dc0991defa4b86f2'], [2, '271ccdb0bd8072af'], [2, 'b2c53570f29d0bf1'],
  [2, 'ff2f9cb113c9a2e6'], [2, '0a59a609f8ca4441'], [2, 'a02df37b53865cf7'], [2, '501351c35ad186fb'], [2, 'bd79f86a27af22a5'], [2, 'b262065100e70e56'], [2, '3b44e432d850013f'], [2, 'ea37c0ebfe262ed4']];
const NAMED: [string, number, number, string][] = [
  ['https://x.io', 1, 3, 'f940be8600419232'],
  ['https://sign.example.org/f/AbCdEfGhIjKl', 3, 2, '0f25f80d06e4b397'],
  ['https://sign.example.org/sign/k3J9xQ2mVb7LpZ0aYt5WcR8uHn1EoS4d', 4, 5, 'b9bebeaa3ef7d9f8'],
  ['https://example.org/f/naïve-café', 3, 0, 'aa9f8568caafc705'],
  ['https://example.org/f/日本語', 3, 2, 'b7cd09e8b8265fd2'],
  ['"><script>alert(1)</script>', 3, 2, '505a8d107891bd3b'],
  ['https://example.org/f/😀🌳', 3, 2, '24b3ac6fe88ca442'],
  ['http://localhost:3000/f/AbCdEfGhIjKl', 3, 3, 'f3eb459a39a8d836'],
];
// Two of them in full, so a change shows up as a picture and not only as a number.
const X_IO = [
  '#######.#.###.#######', '#.....#.####..#.....#', '#.###.#...#.#.#.###.#', '#.###.#.#.###.#.###.#', '#.###.#..##...#.###.#', '#.....#.......#.....#', '#######.#.#.#.#######',
  '........##...........', '#.##.###.##...#..#.##', '#..##..#.##.#########', '.###..##..#.##...#.##', '........##..#..#.#.#.', '..#..###.###.##.##..#', '........#..#....#....',
  '#######.#....#..#....', '#.....#.####...####..', '#.###.#...#.#...#.##.', '#.###.#.###.#.##...#.', '#.###.#.#####.##..#..', '#.....#..#...####...#', '#######.#.#.###.###..'];
const FORM_LINK = [
  '#######......#..#..##.#######', '#.....#...##.#.####.#.#.....#', '#.###.#.#...#..#..###.#.###.#', '#.###.#.##..#.#..#.#..#.###.#', '#.###.#.##.###.##.###.#.###.#', '#.....#.#..#.#.#.#....#.....#',
  '#######.#.#.#.#.#.#.#.#######', '........##.#..##...##........', '#.#####...#.###..###..#####..', '..#.#..#.#..##..####.##.#...#', '..#.#######...####..#.#......', '#..#.#..#..#....#...####.#.#.',
  '#.....#.##.##..#.#.......##..', '#.####....##.#.##.#######...#', '#####.#.#.######.#.....#.##..', '#.#....##....#..#.#.#..##..#.', '...##.#..#.##.##.###.....##..', '##.##..##.......#####.###.#.#',
  '#...#.##...##..###...####.#..', '#...##.##.#.#.###....#.....#.', '#....##........#....#####.###', '........#.##.####.###...#####', '#######..#...###..###.#.###..', '#.....#.######.##..##...#...#',
  '#.###.#.#..##.##.#..#####.#..', '#.###.#.####.#..#.##.....####', '#.###.#.##.#...#############.', '#.....#..##.......#.##.#.#.#.', '#######.####.#.#...#....###..'];

test('the fixed examples are still the matrices the outside decoders read', () => {
  for (let v = 1; v <= 40; v++) {
    const q = qrEncode(textFor(v));
    assert.equal(q.version, v);
    assert.deepEqual([q.mask, hash(q)], PER_VERSION[v - 1], `version ${v}`);
  }
  for (const [text, version, mask, sum] of NAMED) {
    const q = qrEncode(text);
    assert.deepEqual([q.version, q.mask, hash(q)], [version, mask, sum], text);
    assert.equal(readQr(q.modules).text, text);
  }
  assert.deepEqual(rowsOf(qrEncode('https://x.io')), X_IO);
  assert.deepEqual(rowsOf(qrEncode('https://sign.example.org/f/AbCdEfGhIjKl')), FORM_LINK);
  // The same text gives the same code every time: a sheet printed today matches the screen tomorrow.
  assert.deepEqual(qrEncode('https://x.io'), qrEncode('https://x.io'));
});

// ---- 2. Masks and their penalty ------------------------------------------------------------------------------------

const blank = (size: number) => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

test('the penalty counts what the four rules of the standard count', () => {
  // All light, 21 by 21. Rule 1: every row and column is one run of 21, 3 + 16 each, 42 lines. Rule 2: 400 blocks
  // of 2 by 2, 3 each. Rule 3: nothing dark, nothing found. Rule 4: 0% dark is ten steps of 5% from half, the last
  // one not complete, so 9 times 10.
  assert.equal(qrPenalty(blank(21)), 42 * 19 + 400 * 3 + 0 + 90);
  // A chessboard has no run, no block and no finder, and is as near to half dark as 441 modules can be.
  assert.equal(qrPenalty(blank(21).map((r, y) => r.map((_, x) => (x + y) % 2 === 0))), 0);

  // One finder-like stretch (dark, light, 3 dark, light, dark) in the middle of row 10, light all around.
  const mid = blank(21);
  for (const x of [4, 6, 7, 8, 10]) mid[10][x] = true;
  // Rule 1: 20 light rows (19 each), row 10 has one run of 10 (3 + 5), the 5 columns with a dark module have two
  // runs of 10 (8 each, 16), the other 16 columns are one run of 21 (19).
  // Rule 2: 400 blocks, less the 16 that touch a dark module. Rule 3: light for 4 before and for 4 after, 40 each.
  // Rule 4: 5 dark of 441 is still nine full steps from half.
  assert.equal(qrPenalty(mid), (20 * 19 + 8 + 5 * 16 + 16 * 19) + (400 - 16) * 3 + 80 + 90);
  // The same stretch down a column counts the same.
  assert.equal(qrPenalty(mid[0].map((_, x) => mid.map((row) => row[x]))), qrPenalty(mid));

  // At the very edge of the code the margin is the light stretch before it, so both sides still count.
  const edge = blank(21);
  for (const x of [0, 2, 3, 4, 6]) edge[10][x] = true;
  // Row 10 now has one run of 14 after it (3 + 9). The rest is as above: 5 columns of two runs of 10, 16 of one of 21.
  // Blocks that touch a dark module: columns 0 to 6 at two heights, 14.
  assert.equal(qrPenalty(edge), (20 * 19 + 12 + 5 * 16 + 16 * 19) + (400 - 14) * 3 + 80 + 90);
  // With only 3 light modules after it, that side does not count: 40, not 80.
  const tight = blank(21);
  for (const x of [0, 2, 3, 4, 6, 10]) tight[10][x] = true;
  // Row 10 keeps its one long run of 10 (3 + 5), 6 columns have a dark module, and 18 blocks touch one.
  const withoutRule3 = (20 * 19 + 8 + 6 * 16 + 15 * 19) + (400 - 18) * 3 + 90;
  assert.equal(qrPenalty(tight), withoutRule3 + 40);
});

test('all eight masks are tried and the one with the lowest penalty is kept', () => {
  const texts = [...NAMED.map((n) => n[0]), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 20, 27, 40].map(textFor)];
  const chosen = new Set<number>();
  for (const text of texts) {
    const each = Array.from({ length: 8 }, (_, mask) => qrEncode(text, { mask }));
    const scores = each.map((q) => qrPenalty(q.modules));
    const best = scores.indexOf(Math.min(...scores)); // the first of the lowest: a tie goes to the lower number
    const q = qrEncode(text);
    assert.equal(q.mask, best, `${text.slice(0, 40)}: penalties ${scores.join(' ')}`);
    assert.deepEqual(q.modules, each[best].modules);
    chosen.add(q.mask);
    // The eight differ from each other exactly where their mask conditions differ, and only on data modules.
    const fixed = fixedMap(q.version);
    for (let mask = 1; mask < 8; mask++) each[mask].modules.forEach((row, y) => row.forEach((on, x) => {
      if (fixed(y, x)) return;
      assert.equal(on !== each[0].modules[y][x], MASK_OFF[mask](y, x) !== MASK_OFF[0](y, x), `mask ${mask} at ${y},${x}`);
    }));
  }
  assert.ok(chosen.size >= 4, `the choice really depends on the data: masks ${[...chosen].sort().join(', ')} were chosen`);
  for (const bad of [-1, 8, 1.5, NaN, '2' as any]) assert.throws(() => qrEncode('x', { mask: bad }), RangeError);
});

// ---- 3. What does not fit ------------------------------------------------------------------------------------------

test('a text that is too long is refused in plain words, and nothing half made comes back', () => {
  assert.equal(qrEncode('x'.repeat(2331)).version, 40);
  for (const text of ['x'.repeat(2332), 'é'.repeat(1166), '😀'.repeat(583), 'x'.repeat(100_000)]) {
    assert.throws(() => qrEncode(text), (e: any) => {
      assert.ok(e instanceof QrTooLong);
      assert.equal(e.bytes, new TextEncoder().encode(text).length);
      assert.match(e.message, /^This is too long for a QR code: it is \d+ bytes and a code holds 2331 at most\.$/);
      return true;
    });
    assert.throws(() => qrSvg(text), QrTooLong);
  }
});

// ---- 4. The picture -------------------------------------------------------------------------------------------------

// Draws the SVG the only way its text allows: a white square and one path made of runs one module high.
function raster(svg: string) {
  const m = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) (\d+)"(?: width="(\d+)" height="(\d+)")? shape-rendering="crispEdges"><rect width="(\d+)" height="(\d+)" fill="#fff"\/><path d="((?:M\d+ \d+h\d+v1h-\d+z)*)" fill="#000"\/><\/svg>$/.exec(svg);
  assert.ok(m, `the picture is a white square and one path of dark runs, and nothing else: ${svg.slice(0, 200)}`);
  const side = Number(m[1]);
  assert.deepEqual([m[2], m[5], m[6]], [m[1], m[1], m[1]], 'the white square covers the whole picture');
  const dark = blank(side);
  for (const [, x, y, w, back] of m[7].matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    assert.equal(w, back, 'each run closes on itself');
    for (let i = 0; i < Number(w); i++) {
      assert.equal(dark[Number(y)][Number(x) + i], false, 'no module is drawn twice');
      dark[Number(y)][Number(x) + i] = true;
    }
  }
  return { side, dark, px: m[3] ? [Number(m[3]), Number(m[4])] : null };
}

test('the SVG is the matrix with a light margin of four modules, black on white', () => {
  for (const text of [...NAMED.map((n) => n[0]), textFor(7), textFor(13), textFor(40), '']) {
    const q = qrEncode(text);
    const pic = raster(qrSvg(text));
    assert.equal(pic.side, q.size + 2 * QR_QUIET);
    assert.equal(QR_QUIET, 4);
    pic.dark.forEach((row, y) => row.forEach((on, x) => {
      const inside = x >= 4 && y >= 4 && x < 4 + q.size && y < 4 + q.size;
      assert.equal(on, inside ? q.modules[y - 4][x - 4] : false, `${text.slice(0, 30)} at ${x},${y}`);
    }));
    // Cut the margin off and it is the code again, which the reader gives back as the text.
    assert.equal(readQr(pic.dark.slice(4, 4 + q.size).map((r) => r.slice(4, 4 + q.size))).text, text);
    assert.equal(pic.px, null, 'no fixed size unless one is asked for: the picture takes the width of what holds it');
  }
});

test('the margin cannot be made smaller than a reader needs, and a saved picture can carry a size', () => {
  const size = qrEncode('https://x.io').size;
  for (const quiet of [0, 1, 3, -5, NaN, undefined, null, '2', 3.9]) assert.equal(raster(qrSvg('https://x.io', { quiet: quiet as any })).side, size + 8, `quiet ${quiet}`);
  assert.equal(raster(qrSvg('https://x.io', { quiet: 6 })).side, size + 12);
  assert.deepEqual(raster(qrSvg('https://x.io', { px: 512 })).px, [512, 512]);
  for (const px of [0, -3, NaN, '<script>' as any]) assert.equal(raster(qrSvg('https://x.io', { px })).px, null);
  // A code that was made before can be drawn without being made again, and a forced mask is drawn as forced.
  const q = qrEncode('https://x.io', { mask: 6 });
  assert.equal(qrSvg(q), qrSvg('https://x.io', { mask: 6 }));
  assert.notEqual(qrSvg(q), qrSvg('https://x.io'));
});

test('nothing of the text is written into the picture, so no text can break out of it', () => {
  const hostile = ['"><script>alert(1)</script>', '</svg><img src=x onerror=alert(1)>', "' onload='alert(1)", '<!--', ']]>', '&lt;&amp;&#x3c;', 'javascript:alert(1)', 'https://example.org/"/><foreignObject>', '\u0000', '😀"<'];
  for (const text of hostile) {
    const svg = qrSvg(text);
    raster(svg); // throws unless the whole string is the one shape
    assert.match(svg, /^[<>="#\/:. a-zA-Z0-9-]+$/, 'only the characters of the fixed markup, digits and path letters');
    assert.doesNotMatch(svg, /script|onload|onerror|foreignObject|href|<!--|&/i);
    assert.ok(!svg.includes(text));
  }
});

// ---- 5. The checks on a link before a code is drawn ----------------------------------------------------------------

test('a code is made for a web link only, written the way a browser writes it', () => {
  const ok = qrForLink('https://sign.example.org/f/AbCdEfGhIjKl');
  assert.ok(ok.ok);
  assert.equal(ok.link, 'https://sign.example.org/f/AbCdEfGhIjKl');
  assert.equal(ok.reach, 'anywhere');
  assert.equal(ok.note, '');
  assert.deepEqual(rowsOf(ok.qr), FORM_LINK, 'the code on the screen is the fixed example the decoders read');
  assert.equal(readQr(raster(ok.svg).dark.slice(4, -4).map((r) => r.slice(4, -4))).text, ok.link, 'the picture holds the link and nothing else');

  // Whatever is typed, what goes into the code is plain ASCII: a name in another script becomes its xn-- form and
  // other letters in the path are percent-encoded, which is the address a phone would end up at anyway.
  const idn = qrForLink('  https://Пример.рф/f/naïve café  ');
  assert.ok(idn.ok);
  assert.equal(idn.link, 'https://xn--e1afmkfd.xn--p1ai/f/na%C3%AFve%20caf%C3%A9');
  assert.match(idn.link, /^[\x21-\x7e]+$/);
  assert.equal(readQr(idn.qr.modules).text, idn.link);

  const refused: [any, RegExp][] = [
    ['', /^There is no complete link to make a code from\. Copy the link and send it instead\.$/],
    [null, /no complete link/], [undefined, /no complete link/], ['sign.example.org/f/abc', /no complete link/], ['/f/abc', /no complete link/], ['https://', /no complete link/],
    ['javascript:alert(1)', /^A QR code is only made for a web link, one that starts with https:\/\/\.$/],
    ['data:text/html,<script>alert(1)</script>', /only made for a web link/], ['mailto:ada@example.com', /only made for a web link/], ['file:///etc/passwd', /only made for a web link/], ['ftp://example.org/x', /only made for a web link/],
    ['sms:+15551234567', /only made for a web link/], ['tel:+15551234567', /only made for a web link/],
    // A user name in front of the host shows one address and opens another.
    ['https://sign.example.org@evil.example/f/abc', /^This link has a user name in front of its address, which can hide where it really goes\. No code is made for it\.$/],
    ['https://sign.example.org:pw@evil.example/f/abc', /user name in front of its address/], ['https://:pw@evil.example/', /user name in front of its address/],
  ];
  for (const [link, why] of refused) {
    const r = qrForLink(link);
    assert.equal(r.ok, false, String(link));
    if (!r.ok) assert.match(r.why, why, String(link));
    assert.ok(!('svg' in r), 'a refused link gets no picture at all');
  }
});

test('a link longer than 300 characters gets no code, and the person is told what to do instead', () => {
  assert.equal(QR_LINK_MAX, 300);
  const base = 'https://sign.example.org/sign/';
  const fits = qrForLink(base + 'a'.repeat(300 - base.length));
  assert.ok(fits.ok);
  assert.equal(fits.link.length, 300);
  assert.equal(fits.qr.version, 13, 'the finest code a screen ever shows');
  const long = qrForLink(base + 'a'.repeat(301 - base.length));
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.why, 'This link is 301 characters long. A code for more than 300 is too fine for a phone camera to read, so none is made. Copy the link and send it instead.');
  // Counted after the browser has written it out: 100 letters that take 6 characters each are too many.
  assert.equal(qrForLink(`https://sign.example.org/f/${'é'.repeat(100)}`).ok, false);
  // Every link the app hands out is far below the limit: a signing link and a form link on a long host name.
  for (const link of [`https://a-rather-long-name-for-a-signing-service.example.org/sign/${'k'.repeat(64)}`, 'https://a-rather-long-name-for-a-signing-service.example.org/f/AbCdEfGhIjKl']) {
    const r = qrForLink(link);
    assert.ok(r.ok && r.qr.version <= 8, link);
  }
});

test('a link a phone cannot open says so before anyone prints it', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.8.9.10', '0.0.0.0', '[::1]']) assert.equal(qrReach(host), 'computer', host);
  for (const host of ['10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.255', '169.254.10.10', 'printer.local', '[fd12:3456::1]', '[fe80::1]']) assert.equal(qrReach(host), 'network', host);
  for (const host of ['sign.example.org', '8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.1.1', 'localhost.example.org', 'notlocalhost', '[2001:db8::1]', 'fd.example.org', '']) assert.equal(qrReach(host), 'anywhere', host);

  const local = qrForLink('http://localhost:3000/f/AbCdEfGhIjKl');
  assert.ok(local.ok, 'the code is still made: on a test machine that is what is wanted');
  assert.equal(local.reach, 'computer');
  assert.equal(local.note, 'This link points at localhost, which is the computer the app runs on. A phone that scans the code cannot open it. It works once the app is opened under its public address.');
  const lan = qrForLink('http://192.168.1.20:3000/sign/abc');
  assert.ok(lan.ok);
  assert.equal(lan.note, 'This link points at 192.168.1.20, an address inside a private network. A phone can open it only while it is on the same network.');
});

// ---- 6. The words ---------------------------------------------------------------------------------------------------

test('the dialog and the sheet say that the code is the link and who may see it', () => {
  assert.equal(personCodeWarning('Ada Signer', 'signer'), 'This code is the link. Whoever scans it, or takes a photo of it, can open the document and sign it as Ada Signer. Show it only to Ada Signer, and close this window when they have scanned it.');
  assert.equal(personCodeWarning('Ben Boss', 'approver'), 'This code is the link. Whoever scans it, or takes a photo of it, can open the document and approve it as Ben Boss. Show it only to Ben Boss, and close this window when they have scanned it.');
  // Someone who only reads is not said to sign.
  assert.equal(personCodeWarning('Vi Viewer', 'viewer'), 'This code is the link. Whoever scans it, or takes a photo of it, can open the document as Vi Viewer. Show it only to Vi Viewer, and close this window when they have scanned it.');
  assert.equal(personCodeWarning('', 'signer'), 'This code is the link. Whoever scans it, or takes a photo of it, can open the document and sign it as this person. Show it only to the person it is for, and close this window when they have scanned it.');
  // The whole name as the sender wrote it: which word of a name to call someone by is not guessed.
  assert.equal(personScanLine('Ada Signer', 'signer'), 'Ask Ada Signer to point the camera of their phone at this code and tap the link it shows. The document opens on their own phone, and they read and sign there.');
  assert.match(personScanLine('Nguyễn Văn An', 'signer'), /^Ask Nguyễn Văn An to point/);
  assert.match(personScanLine('Ben Boss', 'approver'), /they read and approve there\.$/);
  assert.match(personScanLine('  ', 'cc'), /^Ask them to point .* they read it there\.$/);
  // Someone who has signed and is handed their link again, for their copy: nothing is left to sign, and whoever
  // scans the code can read the signed document and download it, which the warning says.
  assert.equal(personScanLine('Ada Signer', 'signer', true), 'Ask Ada Signer to point the camera of their phone at this code and tap the link it shows. The document opens on their own phone, and as they have finished, they can read it and download a copy there.');
  assert.equal(personCodeWarning('Ada Signer', 'signer', true), 'This code is the link. Whoever scans it, or takes a photo of it, can open the document, read all of it and download a copy, as Ada Signer. Show it only to Ada Signer, and close this window when they have scanned it.');
  for (const role of ['signer', 'approver', 'viewer', 'cc']) {
    assert.doesNotMatch(personScanLine('A', role, true), /sign there|approve there/, role);
    assert.doesNotMatch(personCodeWarning('A', role, true), /sign it|approve it/, role);
  }
  assert.equal(personCodeWarning('', 'signer', true), 'This code is the link. Whoever scans it, or takes a photo of it, can open the document, read all of it and download a copy, as this person. Show it only to the person it is for, and close this window when they have scanned it.');

  // What the sender asked for before the document opens is not in the code, and the dialog says what happens.
  assert.equal(afterScanLine({}), '');
  assert.equal(afterScanLine({ access_code: '', verify: '' }), '');
  assert.equal(afterScanLine({ access_code: '4242' }), 'The access code is not part of the QR code. They are asked for it after scanning, so tell it to them yourself.');
  assert.equal(afterScanLine({ verify: 'sms_code' }), 'After scanning they are asked for a one-time code, which goes to their phone by text message.');
  assert.equal(afterScanLine({ verify: 'email_code' }), 'After scanning they are asked for a one-time code, which goes to their email address.');
  assert.equal(afterScanLine({ access_code: '4242', verify: 'sms_code' }).split('. ').length, 3, 'both are said when both apply');
  assert.equal(afterScanLine({ verify: 'something new' }), '', 'a check this file does not know is not described wrongly');
  assert.doesNotMatch(afterScanLine({ access_code: 'SECRET-9' }), /SECRET-9/, 'the access code itself is never put next to the code');

  assert.equal(QR_SHOW_SECONDS, 120);
  assert.equal(hiddenLine('Ada Signer'), 'The code was taken off the screen after 2 minutes, so that it is not left here for someone other than Ada Signer.');

  // The sheet of a public form. Printed for the people who scan it:
  assert.equal(FORM_SCAN_LINE, 'Point the camera of your phone at this code and tap the link it shows. The form opens in your browser, where you fill in your details and sign. No app and no account are needed.');
  assert.equal(FORM_LINK_LINE, 'The code holds this link and nothing else. If your phone shows a different address, do not open it. You can also type the link yourself. Capital and small letters matter.');
  // Said to the owner on the screen. The cost is only named where signatures are counted at all.
  assert.equal(formCodeWarning(true), 'This code is the link to your form. Whoever scans it, or a photo of it, can open the form, fill it in and sign, and each person who signs uses one of your signatures. Put the sheet up only where the people it is for will see it. When you pause or delete the form, the code stops working with it.');
  assert.equal(formCodeWarning(false), 'This code is the link to your form. Whoever scans it, or a photo of it, can open the form, fill it in and sign. Put the sheet up only where the people it is for will see it. When you pause or delete the form, the code stops working with it.');
  assert.match(FORM_PAUSED_LINE, /^This form is paused\. Someone who scans the code now is told that the form is not available\./);
  assert.match(OWN_PHONE_LINE, /The same form opens on your phone\. Nothing you typed here is carried over/);
  assert.match(SCAN_TROUBLE, /use Copy link\.$/);

  // No em dash, and no promise about what a signature is worth, in anything this file can say.
  const said = [personCodeWarning('A', 'signer'), personScanLine('A', 'signer'), personCodeWarning('A', 'signer', true), personScanLine('A', 'signer', true), afterScanLine({ access_code: '1234', verify: 'email_code' }), hiddenLine('A'), formCodeWarning(true),
    ...Object.values(words).filter((v): v is string => typeof v === 'string'), (qrForLink('x') as any).why, (qrForLink('http://localhost/x') as any).note];
  for (const s of said) {
    assert.doesNotMatch(s, /\u2014|\u2013/, s);
    assert.doesNotMatch(s, /legally|is valid|will hold up|binding/i, s);
  }
});

test('the saved picture gets a file name a disk accepts, whatever the form is called', () => {
  assert.equal(qrFileName('Volunteer waiver'), 'volunteer-waiver-qr-code.png');
  assert.equal(qrFileName('../../etc/passwd'), 'etc-passwd-qr-code.png');
  assert.equal(qrFileName('C:\\Users\\x\\"evil".exe'), 'c-users-x-evil-exe-qr-code.png');
  assert.equal(qrFileName('Café Ärzte 2026'), 'cafe-arzte-2026-qr-code.png');
  assert.equal(qrFileName('日本語'), 'form-qr-code.png');
  assert.equal(qrFileName(''), 'form-qr-code.png');
  assert.equal(qrFileName(null as any), 'form-qr-code.png');
  assert.ok(qrFileName('x'.repeat(500)).length <= 60 + '-qr-code.png'.length);
  for (const name of ['a/b', 'a\\b', 'a:b', 'a\u0000b', 'a\nb', '.hidden', '...']) assert.match(qrFileName(name), /^[a-z0-9][a-z0-9-]*-qr-code\.png$/, name);
});

// ---- 7. The server: the link a code is drawn from ------------------------------------------------------------------

let n = 0;
const newIp = () => `198.51.100.${60 + n++}`;
async function formOf(owner: Client, name: string) {
  const tpl = await simple(owner, '', { kind: 'template', subject: 'Waiver', recipients: [{ id: 'r', role: 'signer', role_name: 'Volunteer' }] });
  const made = await owner.post('/powerforms', { template_id: tpl.id, name });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  return (await owner.get('/powerforms')).data.powerforms.find((p: any) => p.id === made.data.id);
}

test('a form comes with its public address, built from APP_URL and never from the request', async () => {
  const owner = await signUp('Quinn Owner', 'quinn.qr@example.com', newIp());
  const form = await formOf(owner, 'Beach clean-up waiver');
  // Share links: the address a form is handed out under is its readable one, growsigning.com/<name>
  // (tests/share-links.test.ts). It is built from APP_URL like the address with the slug, which keeps working.
  assert.equal(form.url, 'http://test.local/beach-clean-up-waiver');
  assert.equal(form.share_link.url, form.url);
  // A request that claims another host does not get that host printed on a sheet.
  const forged = await owner.call('GET', '/powerforms', undefined, { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' });
  assert.equal(forged.data.powerforms.find((p: any) => p.id === form.id).url, 'http://test.local/beach-clean-up-waiver');

  // The code drawn from it holds exactly that address, and that address is the form.
  const made = qrForLink(form.url);
  assert.ok(made.ok);
  const scanned = readQr(made.qr.modules).text;
  assert.equal(scanned, form.url);
  // The readable address leads to the form by its slug.
  const behind = await new Client().get(`/public/share${new URL(scanned).pathname}`);
  assert.equal(behind.data.state, 'form');
  const slug = behind.data.slug;
  assert.equal(slug, form.slug);
  const open = await new Client().get(`/public/powerforms/${slug}`);
  assert.equal(open.status, 200);
  assert.equal(open.data.name, 'Beach clean-up waiver');

  // The sheet tells the owner: "When you pause or delete the form, the code stops working with it."
  assert.equal((await owner.call('PATCH', `/powerforms/${form.id}`, { active: false })).status, 200);
  const paused = await new Client().get(`/public/powerforms/${slug}`);
  assert.equal(paused.status, 404);
  assert.equal(paused.data.error, 'This form is not available.');
  assert.equal((await new Client().post(`/public/powerforms/${slug}/start`, { name: 'Vi Visitor', email: 'vi@example.com' })).status, 404);
  // The paused form is still on the owner's list, so the sheet can say that it is paused.
  assert.equal((await owner.get('/powerforms')).data.powerforms.find((p: any) => p.id === form.id).active, 0);
  assert.equal((await owner.call('PATCH', `/powerforms/${form.id}`, { active: true })).status, 200);
  assert.equal((await new Client().get(`/public/powerforms/${slug}`)).status, 200, 'the same printed code works again after resuming');
  assert.equal((await owner.call('DELETE', `/powerforms/${form.id}`)).status, 200);
  assert.equal((await new Client().get(`/public/powerforms/${slug}`)).status, 404);

  // Someone else's account does not list the form, so it has no sheet for it.
  const other = await signUp('Olga Other', 'olga.qr@example.com', newIp());
  const mine = await formOf(owner, 'Second form');
  assert.ok(!(await other.get('/powerforms')).data.powerforms.some((p: any) => p.id === mine.id));

  // The address is described for developers too.
  const { openapi } = await import('../src/server/openapi.ts');
  const spec: any = openapi();
  assert.match(JSON.stringify(spec.paths['/powerforms'].get), /"url":\{[^}]*APP_URL/);
});

test('a personal code is the signing link: it opens for whoever scans it, is on record, and dies with the link', async () => {
  const sender = await signUp('Sara Sender', 'sara.qr@example.com', newIp());
  const e = await draft(sender, { subject: 'Side by side' });
  assert.equal((await sender.post(`/envelopes/${e.id}/send`)).status, 200);
  const rid = (email: string) => db.get('SELECT id FROM recipients WHERE envelope_id=? AND email=?', e.id, email).id;
  const issued = () => db.all("SELECT detail FROM audit WHERE envelope_id=? AND action='Signing link issued'", e.id).map((a: any) => a.detail);

  // "Show QR code" asks for the link the same way "Copy link" does.
  const got = await sender.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid('ada@example.com') });
  assert.equal(got.status, 200);
  assert.equal(got.data.url, `http://test.local/sign/${tokenFor(e.id, 'ada@example.com')}`);
  const made = qrForLink(got.data.url);
  assert.ok(made.ok);
  assert.ok(made.qr.version <= 6, 'a signing link makes a code coarse enough to scan off a screen');
  const scanned = readQr(made.qr.modules).text;
  assert.equal(scanned, got.data.url);
  // Showing it again and again leaves one line in the audit trail, which says who the link was for.
  await sender.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid('ada@example.com') });
  assert.deepEqual(issued(), ['Ada Signer <ada@example.com>']);

  // Whoever scans it has the document open as that person. That is why the dialog says to show it to them only.
  const token = new URL(scanned).pathname.replace('/sign/', '');
  const phone = new Client();
  const view = await phone.get(`/sign/${token}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.recipient.name, 'Ada Signer');
  assert.equal(view.data.envelope.status, 'sent');

  // Nobody outside the account can get a link to make a code from, and neither can a key holder of another one.
  const stranger = await signUp('Stan Stranger', 'stan.qr@example.com', newIp());
  assert.equal((await stranger.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid('ada@example.com') })).status, 404);
  assert.equal((await new Client().post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid('ada@example.com') })).status, 401);

  // A corrected address replaces the link. A code that was photographed before then no longer opens the document.
  assert.equal((await sender.post(`/envelopes/${e.id}/correct`, { recipient_id: rid('ada@example.com'), name: 'Ada Signer', email: 'ada.new@example.com' })).status, 200);
  assert.equal((await new Client().get(`/sign/${token}`)).status, 410);
  const fresh = await sender.post(`/envelopes/${e.id}/recipient-view`, { recipient_id: rid('ada.new@example.com') });
  assert.notEqual(fresh.data.url, got.data.url);
  // Voiding ends it for everyone.
  assert.equal((await sender.post(`/envelopes/${e.id}/void`, { reason: 'Wrong version' })).status, 200);
  const after = await new Client().get(`/sign/${new URL(fresh.data.url).pathname.replace('/sign/', '')}`);
  assert.equal(after.data.envelope.status, 'voided', 'a code that is scanned later shows that the envelope was voided');
  const late = await new Client().post(`/sign/${new URL(fresh.data.url).pathname.replace('/sign/', '')}/complete`, { values: {}, signature_png: PNG });
  assert.ok(late.status >= 400, `and nothing can be signed from it: ${late.status}`);
  assert.equal(db.get('SELECT status FROM envelopes WHERE id=?', e.id).status, 'voided');
});

// ---- 8. The pages keep their word ----------------------------------------------------------------------------------

const MINE = ['src/lib/qr.ts', 'src/lib/qrlink.ts', 'src/components/QrCode.tsx', 'src/components/QrOwnPhone.tsx', 'src/components/sender/QrDialog.tsx', 'src/app/app/powerforms/[id]/qr/page.tsx', 'src/app/styles/qr.css'];

test('the code is made here: no library, no outside service, and the link is sent nowhere to draw it', () => {
  const qr = read('src/lib/qr.ts');
  assert.doesNotMatch(qr, /^\s*import\s|require\(|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|navigator\.|document\.|window\./m, 'the encoder imports nothing and touches neither the network nor the page');
  assert.doesNotMatch(read('src/lib/qrlink.ts'), /fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
  const pkg = JSON.parse(read('package.json'));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.doesNotMatch(dep, /qr|zxing|barcode/i, `no QR library in package.json: ${dep}`);
  // Nothing that shows a code talks to anyone while doing so, and no page fetches a code as a picture from elsewhere.
  for (const f of ['src/components/QrCode.tsx', 'src/components/QrOwnPhone.tsx', 'src/components/sender/QrDialog.tsx']) assert.doesNotMatch(read(f), /fetch\(|api\(|<img|https?:\/\//, f);
  const all = fs.readdirSync(new URL('../src', import.meta.url), { recursive: true }).map(String).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => read(`src/${f}`)).join('\n');
  assert.doesNotMatch(all, /qrserver|chart\.googleapis|quickchart|chart\?cht=qr|qr-code-generator\.com|api\.qr/i);
  // The picture only goes into the page through the one component that takes what the encoder drew.
  assert.match(read('src/components/QrCode.tsx'), /role="img" aria-label=\{label\} dangerouslySetInnerHTML=\{\{ __html: svg \}\}/);
  for (const f of ['src/components/QrOwnPhone.tsx', 'src/components/sender/QrDialog.tsx', 'src/app/app/powerforms/[id]/qr/page.tsx']) {
    assert.doesNotMatch(read(f), /dangerouslySetInnerHTML/, f);
    assert.match(read(f), /<QrCode svg=\{made\.svg\} label=/, f);
    assert.match(read(f), /qrForLink\(/, `${f} draws only what passed the checks on a link`);
  }
});

test('each place a link is handed over in person offers a code, with its warning', () => {
  // The envelope page: next to "Copy link", for the same people and no others.
  const people = read('src/components/sender/Recipients.tsx');
  assert.match(people, /\{reachable && <button className="btn sm qr-tap"[^\n]*onClick=\{\(ev\) => showQr\(r, ev\.currentTarget\)\}[^\n]*aria-label=\{`Show a QR code with the signing link for \$\{r\.name\}`\}>QR code<\/button>\}/);
  assert.match(people, /Copy link<\/button>\}\n\s*\{reachable && <button[^\n]*>QR code<\/button>\}/, 'it stands right after Copy link');
  assert.match(people, /const reachable = turn && !isMe && r\.role !== 'inperson'(?: && !own)?;/, 'not for someone who signs on the sender\'s own device, and not before their turn');
  // Also for someone with no email address whose link the sender passes on (OwnLink.tsx), during their turn and
  // afterwards for their copy.
  assert.match(people, /\{qr === r\.id && links\[r\.id\] && (?:turn|\(turn \|\| own\)) && <QrDialog recipient=\{r\} link=\{links\[r\.id\]\} opener=\{qrFrom\} onClose=\{\(\) => setQr\(''\)\} \/>\}/);
  const dialog = read('src/components/sender/QrDialog.tsx');
  // The button that opened it is switched off while the link is fetched, so the browser drops focus. Closing the
  // dialog by Close or by Escape puts the keyboard back on that button (measured in a browser: it was lost before).
  assert.match(people, /async function showQr\(r: any, from\?: HTMLButtonElement\) \{\n\s*qrFrom\.current = from \|\| null;/);
  assert.match(dialog, /const done = \(\) => \{\n\s*const back = opener\?\.current;\n\s*onClose\(\);\n\s*setTimeout\(\(\) => back\?\.isConnected && back\.focus\(\), 0\);/);
  assert.match(dialog, /<Dialog title=\{`QR code for \$\{name\}`\} onClose=\{done\}>/, 'Escape and a click outside go the same way');
  assert.match(dialog, /onClick=\{done\} data-autofocus="">Close<\/button>/);
  assert.doesNotMatch(dialog, /onClick=\{onClose\}|onClose=\{onClose\}/, 'no way out of the dialog that leaves focus behind');
  assert.match(dialog, /<div className="notice warn">\{personCodeWarning\(r\.name, r\.role, finished\)\}<\/div>/);
  assert.match(dialog, /\{personScanLine\(r\.name, r\.role, finished\)\}/);
  assert.match(dialog, /const finished = r\.status === 'completed';/, 'someone who has signed is not told to sign again');
  assert.match(dialog, /afterScanLine\(r\)/);
  assert.match(dialog, /setTimeout\(\(\) => setHidden\(true\), QR_SHOW_SECONDS \* 1000\)/, 'the code leaves the screen by itself');
  assert.match(dialog, /hidden \? \([\s\S]*hiddenLine\(r\.name\)[\s\S]*Show the code again[\s\S]*\) : <QrCode/, 'while it is hidden the picture is not in the page at all');
  assert.match(dialog, /import \{ Dialog \} from '\.\/Dialog';/, 'the dialog that keeps the keyboard inside it and closes on Escape');
  assert.doesNotMatch(dialog, /access_code\}/, 'the access code is never printed next to the code');

  // The PowerForms page: a sheet for each form.
  const forms = read('src/app/app/powerforms/page.tsx');
  assert.match(forms, /<Link className="btn sm qr-tap"(?: style=\{\{ minHeight: 44 \}\})? href=\{`\/app\/powerforms\/\$\{p\.id\}\/qr`\} aria-label=\{`QR code for \$\{p\.name\}, on a sheet to print`\}>QR code<\/Link>/);
  assert.match(forms, /writeText\(p\.url \|\| link\(p\.slug\)\)/, 'the copied link is the public address too');
  const sheet = read('src/app/app/powerforms/[id]/qr/page.tsx');
  assert.match(sheet, /<section className="qr-sheet"[^>]*>\s*<p className="qr-sheet-from">\{me\.account\.name\}<\/p>\s*<h2 className="serif qr-sheet-name">\{p\.name\}<\/h2>\s*<QrCode [^\n]*\/>\s*<p className="qr-sheet-scan">\{FORM_SCAN_LINE\}<\/p>\s*<p className="qr-sheet-small">\{FORM_LINK_LINE\}<\/p>\s*<p className="qr-sheet-link">\{made\.link\}<\/p>\s*<\/section>/,
    'the sheet carries the name of the form, the code, what scanning does, and the link written out');
  assert.match(sheet, /<div className="notice qr-noprint">\{formCodeWarning\(!!me\.billing\?\.enabled\)\}/, 'the owner is told that the code is the link');
  assert.match(sheet, /\{!p\.active && <div className="notice warn qr-noprint" role="status">\{FORM_PAUSED_LINE\}<\/div>\}/);
  assert.match(sheet, /qrForLink\(p\.url \|\| /, 'drawn from the address the server gives');
  assert.match(sheet, /onClick=\{\(\) => window\.print\(\)\}>Print this sheet<\/button>/);
  // Paper gets the sheet only.
  const css = read('src/app/styles/qr.css');
  assert.match(css, /@media print \{[\s\S]*body\.qr-printing \.main > \*:not\(\.qr-page\), body\.qr-printing \.qr-noprint, body\.qr-printing \.toasts \{ display: none !important; \}/);
  // On paper wider than the phone layout the menu's grid column stayed and squeezed the sheet into 232 px.
  assert.match(css, /@media print \{[^@]*body\.qr-printing \.shell \{ display: block; \}/);
  // And the column's screen width (1180 px) would leave the sheet on the left of a landscape A3 page.
  assert.match(css, /@media print \{[^@]*body\.qr-printing \.main \{ padding: 0; max-width: none; \}/);
  assert.match(read('src/app/globals.css'), /\.shell \{ display: grid; grid-template-columns: 232px/, 'the grid this undoes is still the one the app uses');
  assert.match(sheet, /document\.body\.classList\.add\('qr-printing'\);\s*return \(\) => document\.body\.classList\.remove\('qr-printing'\);/);
  assert.match(css, /\(max-width: 900px\), \(pointer: coarse\) \{ \.btn\.qr-tap \{ min-height: 44px; \} \}/, 'a button a finger taps is 44 px high');
  assert.match(read('src/app/layout.tsx'), /import '\.\/styles\/qr\.css';/);

  // The public form itself, on a big screen: the visitor's own phone.
  assert.match(read('src/app/f/[slug]/page.tsx'), /<QrOwnPhone slug=\{slug\} name=\{form\.name\} \/>/);
  const own = read('src/components/QrOwnPhone.tsx');
  assert.match(own, /if \(!made \|\| !made\.ok \|\| made\.reach === 'computer'\) return null;/, 'no button that could only lead nowhere');
  assert.match(own, /aria-expanded=\{open\} aria-controls=\{box\}/);
  assert.match(css, /@media \(max-width: 600px\) \{ \.qr-own \{ display: none; \} \}/);
});

test('the public pages and the README say what is now true about QR codes', () => {
  const landing = read('src/app/features/page.tsx'); // the feature list moved off the home page (simplify-public)
  assert.match(landing, /\['Forms', 'A public link anyone can fill in and sign on their own\. Put it on your website, or print the QR code the app makes for it\./); // shortened by repair-open-public
  assert.doesNotMatch(landing, /we do not make one yet|tool of your own/);
  const help = read('src/app/help/page.tsx');
  assert.match(help, /show it as a QR code/);
  assert.match(read('src/app/security/page.tsx'), /<Point title="A QR code is the link\.">/);
  const readme = read('README.md');
  const notIn = readme.slice(readme.indexOf('## What is not in it'), readme.indexOf('## Configuration'));
  assert.doesNotMatch(notIn, /QR/, 'the README no longer lists QR codes as missing');
  assert.match(readme.slice(readme.indexOf('## What is in it'), readme.indexOf('## What is not in it')).replace(/\s+/g, ' '), /QR codes, made by the app itself/);
  assert.match(readme, /`tests\/qr\.test\.ts`/);
  // None of it in em dashes.
  for (const f of [...MINE, 'tests/qr.test.ts']) assert.doesNotMatch(read(f), /\u2014/, f);
});
