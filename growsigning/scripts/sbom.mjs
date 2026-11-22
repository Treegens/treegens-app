// The software bill of materials: every package the running server is made of, in CycloneDX (made by npm itself:
// npm sbom --sbom-format cyclonedx --omit dev), and a plain list of each package with its licence.
//
//   node scripts/sbom.mjs            (also run by "npm run build", before next build, and by "npm run sbom")
//
// Writes public/security/sbom.json, which the server then serves at /security/sbom.json, and
// public/security/third-party-licences.txt. Both describe the packages installed in node_modules now, so run it where
// the server is built (the Dockerfile does).
//
// It fails, and writes nothing, when a package names no licence that a person has read for it, or names one that is
// not on LICENCES_CHECKED below. The product is to be published under EUPL-1.2 (owner decision, 2026-11-20): the list
// holds the licences that the EUPL-1.2 appendix names as compatible and the permissive licences that only ask for
// their notice to be kept. It is a gate that makes a person look, not legal advice: a new licence is added here only
// after someone has read it.
//
// With SOURCE_DATE_EPOCH set (seconds), the timestamp and serial number come from it and from the contents, so two
// builds of the same lockfile give the same file (see docs/runbooks.md, "Rebuilding the same image").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;

export const LICENCES_CHECKED = new Set([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Zlib', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0',
  'OFL-1.1', 'CC-BY-4.0', 'Python-2.0', 'Bitstream-Vera',
  // Named as compatible in the appendix of EUPL-1.2.
  'MPL-2.0', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'EUPL-1.2',
]);

// Packages whose package.json names no licence, with the licence a person read in the package itself.
export const READ_BY_HAND = {
  'dejavu-fonts-ttf': { licence: 'Bitstream-Vera', note: 'The DejaVu Fonts licence: the Bitstream Vera licence with additions placed in the public domain (LICENSE in the package).' },
};

/** The SPDX ids an expression like "(MIT AND Zlib)" or "Apache-2.0 OR MIT" is made of. */
export const idsOf = (expr) => String(expr || '').replace(/[()]/g, ' ').split(/\s+(?:AND|OR|WITH)\s+|\s+/).map((s) => s.trim()).filter(Boolean);

/** What the components say about their licences, and which of them a person still has to look at. */
export function checkLicences(bom) {
  const rows = [];
  const problems = [];
  for (const c of bom.components || []) {
    const said = (c.licenses || []).map((l) => l.expression || l.license?.id || l.license?.name).filter(Boolean);
    const hand = READ_BY_HAND[c.name];
    const licence = said.length ? said.join(' AND ') : hand?.licence || '';
    rows.push({ name: c.name, version: c.version || '', licence, note: !said.length && hand ? hand.note : '' });
    if (!licence) problems.push(`${c.name} ${c.version || ''} names no licence. Read the package, then add it to READ_BY_HAND in scripts/sbom.mjs.`);
    else for (const id of idsOf(licence)) if (!LICENCES_CHECKED.has(id)) problems.push(`${c.name} ${c.version || ''} is under ${id}, which nobody has checked against EUPL-1.2 yet. A person has to read it before it ships; then add it to LICENCES_CHECKED in scripts/sbom.mjs.`);
  }
  return { rows: rows.sort((a, b) => a.name.localeCompare(b.name)), problems };
}

export function makeSbom({ root = ROOT, epoch = process.env.SOURCE_DATE_EPOCH } = {}) {
  const out = execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const bom = JSON.parse(out);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (bom.metadata?.component) bom.metadata.component.name = pkg.name;
  if (/^\d+$/.test(String(epoch || ''))) {
    bom.metadata.timestamp = new Date(Number(epoch) * 1000).toISOString();
    const h = crypto.createHash('sha256').update(JSON.stringify(bom.components)).digest('hex');
    bom.serialNumber = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  return bom;
}

export function licenceText(rows, pkg, at) {
  return [
    `Third-party software in ${pkg.name} ${pkg.version}, as installed for the server (npm, without development packages), ${at.slice(0, 10)}.`,
    'Made by scripts/sbom.mjs from the same list as /security/sbom.json. Each line: package, version, licence as the package states it.',
    '',
    ...rows.map((r) => `${r.name} ${r.version}: ${r.licence}${r.note ? ` (${r.note})` : ''}`),
    '',
  ].join('\n');
}

if (isMain) {
  let bom;
  try {
    bom = makeSbom();
  } catch (e) {
    console.error(`[sbom] npm sbom did not run: ${e.message}. It needs npm 10.9 or newer and an installed node_modules.`);
    process.exit(1);
  }
  const { rows, problems } = checkLicences(bom);
  if (problems.length) {
    console.error(`[sbom] Nothing written. ${problems.length} package${problems.length === 1 ? ' needs' : 's need'} a person to look at ${problems.length === 1 ? 'its' : 'their'} licence:\n[sbom] ${problems.join('\n[sbom] ')}`);
    process.exit(1);
  }
  const dir = path.join(ROOT, 'public', 'security');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'sbom.json'), JSON.stringify(bom, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'third-party-licences.txt'), licenceText(rows, pkg, bom.metadata.timestamp));
  console.log(`[sbom] ${rows.length} packages, every licence checked. Wrote public/security/sbom.json and public/security/third-party-licences.txt.`);
}
