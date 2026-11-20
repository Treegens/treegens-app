// Copies runtime assets out of node_modules: the PDF viewer (served to the browser),
// signature fonts (browser) and the fonts used when stamping PDFs (server).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = (...p) => path.join(root, ...p);
const cp = (from, to) => {
  if (!fs.existsSync(from)) return console.warn('[copy-assets] missing', from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};

cp(nm('pdfjs-dist/build/pdf.min.mjs'), out('public/pdfjs/pdf.min.mjs'));
cp(nm('pdfjs-dist/build/pdf.worker.min.mjs'), out('public/pdfjs/pdf.worker.min.mjs'));
cp(nm('pdfjs-dist/cmaps'), out('public/pdfjs/cmaps'));
cp(nm('pdfjs-dist/standard_fonts'), out('public/pdfjs/standard_fonts'));
for (const f of ['caveat', 'dancing-script', 'great-vibes', 'sacramento'])
  cp(nm(`@fontsource/${f}/files/${f}-latin-400-normal.woff2`), out(`public/fonts/${f}.woff2`));
for (const f of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'])
  cp(nm('dejavu-fonts-ttf/ttf', f), out('assets/fonts', f));
// The fonts for Chinese, Japanese, Korean, Thai, Devanagari and Khmer in signed PDFs (see scripts/build-fonts.mjs).
// If this fails, the install still succeeds: text in those scripts is then flagged as not printable.
try {
  const { buildFonts } = await import('./build-fonts.mjs');
  const r = buildFonts();
  if (r.fonts >= 0) console.log(`[copy-assets] ${r.fonts} font files for other scripts${r.skipped.length ? `, ${r.skipped.length} left out` : ''}`);
} catch (e) {
  console.warn('[copy-assets] the fonts for other scripts were not prepared:', e?.message);
}
console.log('[copy-assets] done');
