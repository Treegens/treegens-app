// Writes assets/icc/sRGB.icc: the colour profile the PDF/A copies of completed documents name as their output intent
// (src/server/pdfa.ts). It is made here from the published numbers of sRGB (IEC 61966-2-1: the primaries, the D65
// white point and the transfer curve, adapted to the D50 of the profile connection space with the Bradford method),
// so it carries no third party's file and no third party's licence: see assets/icc/LICENSE.txt.
//
// An ICC version 2.1 display profile ("mntr", RGB to XYZ) with the tags a matrix-and-curve profile needs: desc, cprt,
// wtpt, rXYZ, gXYZ, bXYZ and one 1024-point curve shared by rTRC, gTRC and bTRC. Run it again only to change it:
//   node scripts/make-srgb-icc.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function srgbProfile() {
  const s15 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Math.round(v * 65536));
    return b;
  };
  const xyz = (x, y, z) => Buffer.concat([Buffer.from('XYZ \0\0\0\0', 'latin1'), s15(x), s15(y), s15(z)]);
  const desc = (text) => {
    const ascii = Buffer.from(`${text}\0`, 'latin1');
    const head = Buffer.alloc(12);
    head.write('desc', 0, 'latin1');
    head.writeUInt32BE(ascii.length, 8);
    // Unicode: language 0, count 0. ScriptCode: code 0, count 0, 67 bytes.
    return Buffer.concat([head, ascii, Buffer.alloc(8), Buffer.alloc(3 + 67)]);
  };
  const text = (t) => Buffer.concat([Buffer.from('text\0\0\0\0', 'latin1'), Buffer.from(`${t}\0`, 'latin1')]);
  const N = 1024;
  const curve = Buffer.alloc(12 + N * 2);
  curve.write('curv', 0, 'latin1');
  curve.writeUInt32BE(N, 8);
  for (let i = 0; i < N; i++) {
    const v = i / (N - 1);
    const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    curve.writeUInt16BE(Math.round(lin * 65535), 12 + i * 2);
  }
  // The sRGB primaries and white adapted to D50 (Bradford), as ICC profiles for sRGB carry them.
  const tags = [
    ['desc', desc('sRGB IEC61966-2.1')],
    ['cprt', text('No copyright. Made by GrowSigning from the published sRGB numbers; use it freely.')],
    ['wtpt', xyz(0.9642, 1.0, 0.8249)],
    ['rXYZ', xyz(0.4360747, 0.2225045, 0.0139322)],
    ['gXYZ', xyz(0.3850649, 0.7168786, 0.0971045)],
    ['bXYZ', xyz(0.1430804, 0.0606169, 0.7141733)],
    ['rTRC', curve],
    ['gTRC', curve],
    ['bTRC', curve],
  ];
  const pad = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const table = Buffer.alloc(4 + tags.length * 12);
  table.writeUInt32BE(tags.length, 0);
  const blocks = [];
  let at = 128 + table.length;
  const placed = new Map();
  tags.forEach(([sig, data], i) => {
    let where = placed.get(data);
    if (where === undefined) {
      where = at;
      placed.set(data, at);
      const p = pad(data);
      blocks.push(p);
      at += p.length;
    }
    table.write(sig, 4 + i * 12, 'latin1');
    table.writeUInt32BE(where, 8 + i * 12);
    table.writeUInt32BE(data.length, 12 + i * 12);
  });
  const head = Buffer.alloc(128);
  head.writeUInt32BE(at, 0);
  head.writeUInt32BE(0x02100000, 8); // version 2.1
  head.write('mntr', 12, 'latin1');
  head.write('RGB ', 16, 'latin1');
  head.write('XYZ ', 20, 'latin1');
  // Date and time: 2026-01-01 00:00:00, fixed so the file is the same every time it is made.
  [2026, 1, 1, 0, 0, 0].forEach((v, i) => head.writeUInt16BE(v, 24 + i * 2));
  head.write('acsp', 36, 'latin1');
  head.writeUInt32BE(0, 64); // perceptual
  s15(0.9642).copy(head, 68);
  s15(1.0).copy(head, 72);
  s15(0.8249).copy(head, 76);
  return Buffer.concat([head, table, ...blocks]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icc', 'sRGB.icc');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, srgbProfile());
  console.log(`[icc] wrote ${out}`);
}
