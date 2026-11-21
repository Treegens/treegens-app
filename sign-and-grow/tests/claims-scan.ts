// The honesty scan (tests/gov-g01.test.ts): every place where words a person can read name a certification, an
// accreditation or a legal status, or use one of the risky words about signatures and the law.
//
// What is read: text a person can see. In src/ that is what is left of a .ts or .tsx file once its comments are
// taken out (JSX text, the strings of emails, PDFs and API messages), and the JSON of the screens' words. README.md,
// .env.example, and the text files under public/ and docs/ are read whole. src/lib/claims.ts is not read: it is the
// registry, and its sentences are made by claimText().
//
// A hit is not a failure by itself. tests/claims-allow.json is the reviewed list of sentences that may stay, each
// with why. Anything else fails, and so does a sentence that denies something the registry now says is held.
import fs from 'node:fs';
import path from 'node:path';

export type Pattern = { key: string; re: RegExp; claim?: string };

// Names, with their usual spellings. Word edges everywhere, so a hex colour such as #c5c508 is never a hit.
export const NAME_PATTERNS: Pattern[] = [
  { key: 'ISO 27xxx', re: /\bISO(?:\s*\/\s*IEC)?[\s-]?27\d{3}\b/i, claim: 'iso-27001' },
  { key: 'SOC 2', re: /\bSOC[\s-]?(?:2|II)\b/i, claim: 'soc2-type2' },
  { key: 'FedRAMP', re: /\bFed[\s-]?RAMP\b/i, claim: 'fedramp-moderate' },
  { key: 'GovRAMP', re: /\b(?:Gov|State)RAMP\b/i, claim: 'govramp' },
  { key: 'DoD IL', re: /\b(?:DoD\s+)?(?:IL|Impact Level)\s?[2456]\b/, claim: 'dod-il4' },
  { key: 'BSI C5', re: /\bBSI[\s-]?C5\b|\bC5\s+(?:attestation|testat|report|catalogue|criteria)\b/i, claim: 'bsi-c5' },
  { key: 'ENS', re: /\bEsquema Nacional de Seguridad\b|\bENS\s+(?:alta|media|high|medium|certificat\w+)\b/i, claim: 'ens' },
  { key: 'ACN', re: /\bACN\s+(?:QC\d?|qualif\w+)\b/i, claim: 'acn-qc' },
  { key: 'SecNumCloud', re: /\bSecNumCloud\b/i, claim: 'secnumcloud' },
  { key: 'ISMAP', re: /\bISMAP\b/, claim: 'ismap' },
  { key: 'CSAP', re: /\bCSAP\b/, claim: 'csap' },
  { key: 'IRAP', re: /\bIRAP\b/, claim: 'irap' },
  { key: 'PBMM', re: /\bPBMM\b|\bProtected B\b/, claim: 'cccs-pbmm' },
  { key: 'Cyber Essentials', re: /\bCyber Essentials\b/i, claim: 'cyber-essentials-plus' },
  { key: 'G-Cloud', re: /\bG-Cloud\b/i, claim: 'g-cloud' },
  { key: 'QTSP', re: /\bQTSPs?\b|\bqualified trust service provider/i, claim: 'eidas-qtsp' },
  { key: 'eIDAS', re: /\beIDAS\b/i, claim: 'eidas-qtsp' },
  { key: 'QES', re: /\bQES\b/, claim: 'qes' },
  { key: 'FIPS', re: /\bFIPS\b/, claim: 'fips-140-3' },
  { key: 'WCAG', re: /\bWCAG\b|\bEN\s?301\s?549\b/i, claim: 'wcag-audit' },
  { key: 'Section 508', re: /\bSection\s+508\b|\b508[\s-](?:compliant|compliance|conformance|conformant)\b/i, claim: 'section-508-acr' },
  { key: 'VPAT', re: /\bVPAT\b|\bAccessibility Conformance Report\b/i, claim: 'section-508-acr' },
  { key: 'HIPAA', re: /\bHIPAA\b|\bbusiness associate agreement\b/i, claim: 'hipaa-baa' },
  { key: 'Digital Public Good', re: /\bDigital Public Goods?\b/i, claim: 'dpg-registry' },
  { key: 'CCA', re: /\bCCA\s+(?:ESP|licen[cs]ed|empanel\w+)\b|\beSign Service Provider\b/i, claim: 'cca-esp' },
  { key: 'ICP-Brasil', re: /\bICP[\s-]Brasil\b/i, claim: 'icp-brasil' },
];

// Words that turn a plain sentence into a claim about the law or about a standard.
export const RISKY_PATTERNS: Pattern[] = [
  { key: 'qualified electronic signature', re: /\bqualified["'”’]?\s+(?:electronic\s+)?(?:signatures?|seals?|certificates?|time[\s-]?stamps?)\b/i, claim: 'qes' },
  { key: 'advanced electronic signature', re: /\badvanced["'”’]?\s+(?:electronic\s+)?(?:signatures?|seals?)\b/i, claim: 'qes' },
  { key: 'legally binding', re: /\blegally[\s-](?:binding|valid|enforceable)\b/i },
  { key: 'compliant', re: /\b(?:non-?)?compliant\b|\bcomplies\s+with\b|\bin\s+compliance\s+with\b/i },
  { key: 'certified', re: /\bcertified\b/i },
  { key: 'accredited', re: /\baccredited\b/i },
];

export const ALL_PATTERNS = [...NAME_PATTERNS, ...RISKY_PATTERNS];

export type Hit = { file: string; line: number; text: string; key: string; claim?: string };

const SKIP = new Set(['src/lib/claims.ts']);
const TEXT_EXT = /\.(md|txt|html?|json|webmanifest|xml|svg|ya?ml|csv)$/i;

function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** The files a person's words can come from, as paths from the project folder. */
export function scannedFiles(root: string): string[] {
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');
  const files = [
    ...walk(path.join(root, 'src'), (f) => /\.(tsx?|json)$/.test(f)),
    ...walk(path.join(root, "public"), (f) => (TEXT_EXT.test(f) || /\.js$/.test(f)) && !f.includes(`${path.sep}pdfjs${path.sep}`)),
    ...walk(path.join(root, 'docs'), (f) => TEXT_EXT.test(f)),
    ...['README.md', '.env.example'].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f)),
  ].map(rel);
  return files.filter((f) => !SKIP.has(f)).sort();
}

/**
 * A .ts or .tsx file without its comments, line numbers kept. A block comment is blanked out, and so is everything
 * after "//" when that stands at the start of a line or after a space (so the // of a web address stays).
 */
export function withoutComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}

export function scanText(file: string, raw: string, patterns: Pattern[] = ALL_PATTERNS): Hit[] {
  const text = /\.tsx?$/.test(file) ? withoutComments(raw) : raw;
  const hits: Hit[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const p of patterns) {
      if (p.re.test(line)) hits.push({ file, line: i + 1, text: line.trim(), key: p.key, claim: p.claim });
      else {
        // A phrase broken over two lines ("a qualified" / "signature"): found when it starts on this line.
        const next = (lines[i + 1] || '').trim();
        const m = next ? p.re.exec(`${line} ${next}`) : null;
        if (m && m.index < line.length && m.index + m[0].length > line.length) hits.push({ file, line: i + 1, text: `${line.trim()} ${next}`, key: p.key, claim: p.claim });
      }
    }
  });
  return hits;
}

export function scan(root: string): Hit[] {
  return scannedFiles(root).flatMap((f) => scanText(f, fs.readFileSync(path.join(root, f), 'utf8')));
}
