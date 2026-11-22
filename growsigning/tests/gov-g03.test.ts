// G03, the procurement pack: the documents under docs/procurement (and docs/controls.md, docs/runbooks.md), the
// pages /procurement and /security/subprocessors, and what keeps the documents true to the code.
//
//   node --experimental-strip-types --no-warnings --test tests/gov-g03.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Every file a document names in backticks: `src/...`, `scripts/...`, `docs/...` and the like. */
export function citedPaths(md: string): string[] {
  const re = /`((?:src|scripts|docs|tests|deploy|public)\/[^`\s]+|Dockerfile|README\.md|docker-compose\.example\.yml|\.env\.example|package\.json)`/g;
  return [...new Set([...md.matchAll(re)].map((m) => m[1]))];
}

/** The rows of a markdown table under a heading, as arrays of cells. */
function tableUnder(md: string, heading: string): string[][] {
  const at = md.indexOf(`\n## ${heading}\n`);
  assert.ok(at >= 0, `no section "${heading}"`);
  const rest = md.slice(at + heading.length + 5);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).split('\n').filter((l) => l.startsWith('| ') && !/^\|\s*-/.test(l)).slice(1)
    .map((l) => l.split(' | ').map((c) => c.replace(/^\|\s*|\s*\|$/g, '').trim()));
}

// The calls of node:crypto the whitepaper's inventory has to account for.
const TRACKED = ['scryptSync', 'createCipheriv', 'createDecipheriv', 'hkdfSync', 'pbkdf2Sync', 'createHmac', 'createHash', 'sign', 'verify', 'randomBytes', 'randomInt', 'timingSafeEqual'];

/** Which files under src/server and scripts call each tracked primitive. `sign` and `verify` only as crypto.sign(. */
export function cryptoScan(root = ROOT): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(TRACKED.map((t) => [t, new Set()]));
  const files = [
    ...fs.readdirSync(path.join(root, 'src/server')).filter((f) => f.endsWith('.ts')).map((f) => `src/server/${f}`),
    ...fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`),
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const t of TRACKED) {
      const re = t === 'sign' || t === 'verify' ? new RegExp(`\\bcrypto\\.${t}\\s*\\(`) : new RegExp(`\\b${t}\\s*\\(`);
      if (re.test(src)) out.get(t)!.add(f);
    }
  }
  return out;
}

// ---- 2. The security whitepaper ---------------------------------------------------------------------------------

test('whitepaper: dated, "What this is not" first, every cited file exists', () => {
  const md = read('docs/procurement/security-whitepaper.md');
  assert.match(md, /^# .+\n\nWritten on \d{1,2} [A-Z][a-z]+ \d{4}, from the code as it was that day\.\n\n## What this is not\n/);
  const cited = citedPaths(md);
  assert.ok(cited.length > 30, `only ${cited.length} files cited`);
  const missing = cited.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  assert.deepEqual(missing, [], `cited but not there: ${missing.join(', ')}`);
});

test('whitepaper: the crypto inventory names exactly the files that call each primitive', () => {
  const md = read('docs/procurement/security-whitepaper.md');
  const rows = tableUnder(md, 'Crypto inventory');
  const documented = new Map<string, Set<string>>();
  for (const r of rows) {
    const call = /`crypto\.(\w+)`/.exec(r[0])?.[1];
    assert.ok(call, `a row without a call: ${r[0]}`);
    documented.set(call, new Set(citedPaths(r[2] || '')));
  }
  const scanned = cryptoScan();
  for (const [t, files] of scanned) {
    if (!files.size) continue;
    const doc = documented.get(t);
    assert.ok(doc, `crypto.${t} is used in ${[...files].join(', ')} and the whitepaper's crypto inventory has no row for it`);
    const undocumented = [...files].filter((f) => !doc.has(f));
    assert.deepEqual(undocumented, [], `crypto.${t} is used in files the inventory does not name. Write them into docs/procurement/security-whitepaper.md`);
    const stale = [...doc].filter((f) => !files.has(f));
    assert.deepEqual(stale, [], `the inventory names files for crypto.${t} that no longer use it`);
  }
  for (const t of documented.keys()) assert.ok(scanned.get(t)?.size, `the inventory has a row for crypto.${t}, which nothing uses`);
});

test('whitepaper: every file that imports node:crypto is in the inventory', () => {
  const md = read('docs/procurement/security-whitepaper.md');
  const inventory = new Set(tableUnder(md, 'Crypto inventory').flatMap((r) => citedPaths(r[2] || '')));
  // Files that use node:crypto for nothing the table tracks (a type only, for example) go here, with why.
  const NOTHING_TRACKED: Record<string, string> = {};
  const importers = fs.readdirSync(path.join(ROOT, 'src/server')).filter((f) => f.endsWith('.ts')).map((f) => `src/server/${f}`)
    .filter((f) => /from 'node:crypto'|from 'crypto'|require\('(node:)?crypto'\)/.test(read(f)));
  const left = importers.filter((f) => !inventory.has(f) && !NOTHING_TRACKED[f]);
  assert.deepEqual(left, [], 'these files import node:crypto and the crypto inventory does not name them');
});

test('whitepaper: the scan sees a new primitive in a file', () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'tests', 'out', '.g03-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src/server'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.writeFileSync(path.join(tmp, 'src/server/new.ts'), "import crypto from 'node:crypto';\nexport const k = crypto.pbkdf2Sync('a', 'b', 1, 32, 'sha256');\nexport const s = crypto.sign(null, Buffer.from('x'), 'k');\n");
    const s = cryptoScan(tmp);
    assert.deepEqual([...s.get('pbkdf2Sync')!], ['src/server/new.ts']);
    assert.deepEqual([...s.get('sign')!], ['src/server/new.ts']);
    assert.equal(s.get('createHash')!.size, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- 3 to 7. Every document of the pack ---------------------------------------------------------------------------

import { PROCUREMENT_DOCS, procurementDoc, writtenOn, sizeWords } from '../src/lib/procurement.ts';
import { scanText } from './claims-scan.ts';

const NEW_DOCS = PROCUREMENT_DOCS.filter((d) => d.file.startsWith('docs/procurement/'));

test('pack: every listed document exists, is dated, and says what it is not before anything else', () => {
  assert.ok(PROCUREMENT_DOCS.length >= 8);
  assert.equal(new Set(PROCUREMENT_DOCS.map((d) => d.slug)).size, PROCUREMENT_DOCS.length);
  for (const d of PROCUREMENT_DOCS) {
    assert.match(d.slug, /^[a-z0-9-]+\.md$/, d.slug);
    const md = read(d.file);
    assert.ok(writtenOn(md), `${d.file} says no "Written on <day> <Month> <year>"`);
    const first = /^## (.+)$/m.exec(md)?.[1];
    assert.equal(first, 'What this is not', `${d.file}: the first section must be "What this is not"`);
  }
  // Nothing in docs/procurement that the page does not list.
  const onDisk = fs.readdirSync(path.join(ROOT, 'docs/procurement')).map((f) => `docs/procurement/${f}`).sort();
  assert.deepEqual(onDisk, NEW_DOCS.map((d) => d.file).sort());
});

test('pack: every file a document cites exists', () => {
  for (const d of PROCUREMENT_DOCS) {
    const missing = citedPaths(read(d.file)).filter((p) => !fs.existsSync(path.join(ROOT, p)));
    assert.deepEqual(missing, [], `${d.file} cites files that are not there`);
  }
});

test('pack: no claim words, no em dashes, the honesty scan finds nothing in the new documents and pages', () => {
  const files = [...NEW_DOCS.map((d) => d.file), 'src/app/procurement/page.tsx', 'src/app/security/subprocessors/page.tsx', 'src/lib/procurement.ts', 'src/app/procurement/[doc]/route.ts'];
  for (const f of files) {
    const raw = read(f);
    assert.ok(!raw.includes('—'), `${f} has an em dash`);
    assert.doesNotMatch(raw, /secure by design|\bcompliant\b|\bcertified\b|\bguarantee/i, f);
    assert.deepEqual(scanText(f, raw).map((h) => `${h.line}: ${h.text}`), [], `${f}: the honesty scan of tests/claims-scan.ts found words that need a review`);
  }
});

test('self-mapping: titled as a self-assessment, ISO Annex A by theme, nothing claimed for NIST, no stale "no leaked-password check"', () => {
  const md = read('docs/controls.md');
  assert.match(md.split('\n').slice(0, 4).join('\n'), /A self-assessment by the authors\. Not audited/);
  assert.match(md, /NIST SP 800-53 is not covered at all/);
  for (const t of ['### 5 Organizational controls', '### 6 People controls', '### 7 Physical controls', '### 8 Technological controls']) assert.ok(md.includes(t), t);
  // The leaked-password check exists (src/server/pwned.ts): the mapping must not deny it.
  assert.ok(fs.existsSync(path.join(ROOT, 'src/server/pwned.ts')));
  assert.doesNotMatch(md, /not checked against lists of leaked passwords|no check of passwords against leaked lists/);
  assert.match(md, /src\/server\/pwned\.ts/);
});

test('data processing terms: marked as a template, each clause noted, the help chat named, no hours promised', () => {
  const md = read('docs/procurement/data-processing-terms-template.md');
  assert.match(md, /\*\*Template for a lawyer\. Not legal advice\. Not a contract until signed\.\*\*/);
  const clauses = md.split(/\n## \d+\. /).slice(1);
  assert.ok(clauses.length >= 12, `only ${clauses.length} clauses`);
  for (const c of clauses) assert.match(c, /> (Made true by the software|A promise only|Partly made true by the software|Write schedule)/, `a clause without a note: ${c.slice(0, 60)}`);
  // The critic: the AI provider is a sub-processor, and "no secondary use" is not true for the chat without a choice.
  assert.match(md, /The help chat\. When an AI model answers the help chat/);
  assert.match(md, /Without one of these, clause 3 is not true for the chat/);
  // Breach notice: the hours are left for the parties, tied to a named contact.
  const breach = clauses.find((c) => c.startsWith('Breaches'))!;
  assert.match(breach, /within \[ \] hours/);
  assert.match(breach, /named, staffed contact/);
  assert.doesNotMatch(md, /\b(24|72) hours\b/);
});

test('incident response: no deadline promised, the alerts named match the code', async () => {
  const md = read('docs/procurement/incident-response.md');
  assert.doesNotMatch(md, /\bwithin (24|72) hours\b/);
  const { SECURITY_ALERT_LIST } = await import('../src/lib/seclog.ts');
  assert.equal(SECURITY_ALERT_LIST.length, 5, 'the incident response document lists five account alerts; update it');
  assert.match(md, /The software sends no breach notice to anyone/);
  assert.match(md, /`docs\/runbooks\.md`/);
});

test('exit plan: names every folder the export writes', () => {
  const md = read('docs/procurement/exit-plan.md');
  const trust = read('src/server/routes-trust.ts');
  const named = [...trust.matchAll(/'(signed|audit|comments|stamps|security)\/ {2,}/g)].map((m) => m[1]);
  for (const n of [...named, 'originals', 'envelopes.csv', 'deletion-record.csv', 'README.txt']) assert.ok(md.includes(n.includes('.') ? `\`${n}\`` : `\`${n}/\``), `the exit plan does not name ${n}`);
  assert.match(md, /G19/);
});

test('procurement list: dates and sizes in words', () => {
  assert.equal(writtenOn('# X\n\nWritten on 21 November 2026, from the code.'), '2026-11-21');
  assert.equal(writtenOn('Written on 3 March 2027.'), '2027-03-03');
  assert.equal(writtenOn('written on 3 March 2027'), null);
  assert.equal(writtenOn('Written on 40 March 2027'), null);
  assert.equal(writtenOn('Written on 3 Marchember 2027'), null);
  assert.equal(sizeWords(500), '500 bytes');
  assert.equal(sizeWords(12_300), '12 KB');
  assert.equal(procurementDoc('../package.json'), null);
  assert.equal(procurementDoc('security-whitepaper.md')?.file, 'docs/procurement/security-whitepaper.md');
});

// ---- 8 and 9. The pages and the downloads -------------------------------------------------------------------------

test('downloads: each listed document is served as Markdown; nothing else is, however the address is written', async () => {
  process.chdir(ROOT);
  const { GET } = await import('../src/app/procurement/[doc]/route.ts');
  const get = (doc: string) => GET(new Request(`http://x/procurement/${doc}`), { params: Promise.resolve({ doc }) });
  for (const d of PROCUREMENT_DOCS) {
    const r = await get(d.slug);
    assert.equal(r.status, 200, d.slug);
    assert.equal(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.match(r.headers.get('content-disposition') || '', new RegExp(`attachment; filename="growsigning-${d.slug.replace('.', '\\.')}"`));
    assert.equal(await r.text(), read(d.file));
  }
  for (const bad of ['../package.json', '..%2Fpackage.json', '%2e%2e%2fREADME.md', 'controls', 'CONTROLS.md', '.env', 'docs%2Fcontrols.md', '', '%E0%A4%A']) {
    let r: Response;
    try { r = await get(bad); } catch (e) { assert.fail(`${bad} threw ${e}`); }
    assert.equal(r.status, 404, bad);
    // A small page with a way back, not bare text (the simplicity review); nothing of the address is echoed.
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8', bad);
    const body = await r.text();
    assert.match(body, /There is no procurement document at this address\./);
    assert.match(body, /<a href="\/procurement">Open the list of procurement documents<\/a>/);
    if (bad) assert.ok(!body.includes(bad), `${bad} is echoed`);
  }
});

test('downloads: a server installed without docs/ says so instead of failing', async () => {
  const { GET } = await import('../src/app/procurement/[doc]/route.ts');
  const empty = fs.mkdtempSync(path.join(ROOT, 'tests', 'out', '.g03-nodocs-'));
  const was = process.cwd();
  try {
    process.chdir(empty);
    const r = await GET(new Request('http://x/procurement/exit-plan.md'), { params: Promise.resolve({ doc: 'exit-plan.md' }) });
    assert.equal(r.status, 404);
    assert.match(await r.text(), /installed without its docs folder.*docs\/procurement\/exit-plan\.md/s);
  } finally {
    process.chdir(was);
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('sub-processors: only switched-on providers, with their country, the AI host when the chat has a model', async () => {
  const { dataPlace } = await import('../src/lib/dataplace.ts');
  const none = dataPlace({ NODE_ENV: 'production' });
  assert.deepEqual(none.processors.map((p) => p.id), ['host']);
  const some = dataPlace({ SMTP_URL: 'smtp://relay.example.org', MAIL_PROVIDER_NAME: 'Relay Co', MAIL_PROVIDER_COUNTRY: 'Germany', OPENROUTER_API_KEY: 'k', SUPPORT_CHAT_PROVIDER_COUNTRY: 'United States' });
  const ids = some.processors.map((p) => p.id);
  assert.ok(ids.includes('mail'));
  assert.equal(some.processors.find((p) => p.id === 'mail')!.country, 'Germany');
  // The critic: the AI model's host is a sub-processor, with its country.
  const chat = some.processors.find((p) => p.id === 'chat');
  assert.ok(chat, 'the help chat provider is not listed');
  assert.equal(chat.name, 'OpenRouter');
  assert.equal(chat.country, 'United States');
  assert.match(chat.purpose, /reached at openrouter\.ai/);
  // The page reads the same function, and the other outside services that are on, and nothing typed in.
  const page = read('src/app/security/subprocessors/page.tsx');
  assert.match(page, /const d = dataPlace\(\);/);
  assert.match(page, /<ProcessorTable d=\{d\} \/>/);
  assert.match(page, /outsideShown\(\)\.filter\(\(s\) => s\.on/);
});

test('procurement page: lists every document with its date, links only what exists, certifications from the registry', () => {
  const page = read('src/app/procurement/page.tsx');
  assert.match(page, /PROCUREMENT_DOCS\.map/);
  assert.match(page, /writtenOn\(text\)/);
  assert.match(page, /claimsSummary\(\)/);
  assert.match(page, /installed without its docs folder/);
  // The bill of materials is linked only when the build made it.
  assert.match(page, /const sbom = fs\.existsSync\(at\('public\/security\/sbom\.json'\)\);/);
  // The footer's Trust group and /security carry the two pages (designer note gov-G03).
  const footer = read('src/components/Public.tsx');
  assert.match(footer, /<Link href="\/security\/subprocessors">Sub-processors<\/Link>/);
  assert.match(footer, /<Link href="\/procurement">Procurement documents<\/Link>/);
  assert.match(read('src/app/security/page.tsx'), /href="\/procurement"/);
});

test('bill of materials: the script runs on this checkout and lists pdf-lib with its licence', async () => {
  const { makeSbom, checkLicences } = await import('../scripts/sbom.mjs');
  const bom = makeSbom({ root: ROOT, epoch: '1700000000' });
  const { rows, problems } = checkLicences(bom);
  assert.deepEqual(problems, []);
  const pdfLib = rows.find((r: any) => r.name === 'pdf-lib');
  assert.ok(pdfLib, 'pdf-lib is not in the bill of materials');
  assert.equal(pdfLib.licence, 'MIT');
});

// ---- Repairs after the skeptic and the simplicity review ----------------------------------------------------------

test('repair: the time-stamp service is listed whenever it is set up, seal or not, because the record is stamped either way', async () => {
  const { outsideShown, TSA_WITHOUT_SEAL } = await import('../src/lib/outside-shown.ts');
  // Without a seal key: on, with words that do not speak of a seal or of certificate checks that do not happen.
  const bare = outsideShown({ TSA_URL: 'https://tsa.example.org/' }).find((s) => s.id === 'tsa')!;
  assert.equal(bare.on, true);
  assert.deepEqual(bare.hosts, ['tsa.example.org']);
  assert.equal(bare.purpose, TSA_WITHOUT_SEAL);
  assert.ok(!/seal|OCSP/i.test(bare.purpose));
  // The server really does call it without a seal: finishPdf stamps the chain head, which needs only tsaUrls().
  assert.match(read('src/server/finalpipe.ts'), /const chain = await stampChainHead\(e\.id, until\);/);
  assert.match(read('src/server/auditstamp.ts'), /const urls = tsaUrls\(\);\n\s*if \(!urls\.length\) return null;/);
  // With a seal key: the full words, certificate checks included.
  const sealed = outsideShown({ TSA_URL: 'https://tsa.example.org/', SEAL_KEY_PEM: 'x' }).find((s) => s.id === 'tsa')!;
  assert.match(sealed.purpose, /digital seal/);
  assert.match(sealed.purpose, /OCSP/);
  // Off, it is still a row (so "on or off" on /security is true), just not on.
  assert.equal(outsideShown({}).find((s) => s.id === 'tsa')!.on, false);
  // Neither page filters it out by the seal any more; both read the one function.
  for (const f of ['src/app/security/Outside.tsx', 'src/app/security/subprocessors/page.tsx']) {
    const src = read(f);
    assert.ok(!/sealSet\(\)/.test(src), `${f} still hides the time-stamp service without a seal`);
    assert.match(src, /outsideShown\(\)/, f);
  }
});

test('repair: the converter says it receives whole files; webhooks are said without sender jargon', async () => {
  const { outsideShown } = await import('../src/lib/outside-shown.ts');
  const conv = outsideShown({ CONVERTER_URL: 'http://gotenberg:3000' }).find((s) => s.id === 'converter')!;
  assert.equal(conv.on, true);
  assert.match(conv.purpose, /receives the whole file/);
  const hooks = outsideShown({}).find((s) => s.id === 'webhooks')!;
  assert.ok(!/envelope|audit trail/i.test(`${hooks.name} ${hooks.purpose}`));
  assert.match(hooks.purpose, /Nothing is sent until an admin adds an address\./);
  // The page does not print the technical "(any public https address ...)" after the webhook row.
  assert.match(read('src/app/security/subprocessors/page.tsx'), /s\.hostWords && s\.id !== 'webhooks'/);
  // The host row does not say "audit trails" to a buyer.
  const { dataPlace } = await import('../src/lib/dataplace.ts');
  assert.ok(!/audit trail/i.test(dataPlace({}).processors[0].data));
});

test('repair: what the operator has not stated is said once, with a way to ask', async () => {
  const { unstatedSentence } = await import('../src/lib/outside-shown.ts');
  const { dataPlace } = await import('../src/lib/dataplace.ts');
  const s = unstatedSentence(dataPlace({}).unstated)!;
  assert.equal(s, 'The operator of this server has not said who they are, which company hosts it, where it is hosted or whether and where backups are kept.');
  assert.ok(!/Ask them/.test(s));
  assert.equal(unstatedSentence(['The operator of this server has not said who they are. Ask them.']), 'The operator of this server has not said who they are.');
  assert.equal(unstatedSentence([]), null);
  const page = read('src/app/security/subprocessors/page.tsx');
  assert.ok(!/d\.unstated\.map/.test(page), 'the page lists "Ask them" once per item again');
  assert.match(page, /the contact form<\/Link>/);
  assert.match(page, /Server operated by: \{d\.operator \?/);
});

test('repair: nothing on /security says revocation checks are not built while ltv.ts makes them', async () => {
  const { NOT_BUILT } = await import('../src/lib/outside.ts');
  assert.match(read('src/server/ltv.ts'), /application\/ocsp-request/);
  assert.ok(!NOT_BUILT.some((x) => /OCSP|revocation/i.test(x)));
  // Two since the WhatsApp line went: the owner decided no account gets WhatsApp, so it is not named at all.
  assert.ok(NOT_BUILT.length >= 2);
});

test('repair: the documents say what the code does about the router, the browser hash, closing an account and what leaves', () => {
  const wp = read('docs/procurement/security-whitepaper.md');
  assert.ok(!/every route reads through the caller's account/i.test(wp));
  assert.match(wp, /each handler filters its own queries by it/);
  assert.match(wp, /WebCrypto/);
  assert.match(read('src/app/verify/ById.tsx'), /crypto\.subtle\.digest\('SHA-256'/);
  const dpia = read('docs/procurement/dpia-pack.md');
  assert.match(dpia, /each handler filters by it/);
  assert.match(read('src/server/routes-envelopes.ts'), /export function mine\(/);
  const dpa = read('docs/procurement/data-processing-terms-template.md');
  assert.ok(!/closing an account with a grace period and then deleting it \(`src\/server\/deleting\.ts`\)/.test(dpa));
  assert.match(dpa, /CLOSE_GRACE_DAYS/);
  assert.match(read('src/server/routes-trust.ts'), /CLOSE_GRACE_DAYS/);
  const tia = read('docs/procurement/transfer-impact-assessment-template.md');
  assert.match(tia, /Also connected to/);
  assert.match(tia, /CONVERTER_URL/);
  assert.match(tia, /receives the whole of every Word/);
  assert.match(tia, /src\/server\/auditstamp\.ts/);
  assert.match(tia, /OCSP/);
  assert.ok(!/receives only a fingerprint of the seal/.test(tia));
});

test('repair: /procurement downloads name their document on screen; links in lines are 44 px tall', () => {
  const page = read('src/app/procurement/page.tsx');
  assert.match(page, />Download \{d\.title\} \(text file, \{sizeWords\(info\.size\)\}\)<\/a>/);
  assert.match(page, /Each one is a plain text file \(\.md\) that opens in any text editor\./);
  assert.ok(!/the two pages below/.test(page));
  assert.ok(!/Markdown text/.test(page));
  for (const href of ['/security/subprocessors', '/security/processing', '/security/disclosure']) assert.match(page, new RegExp(`href="${href}" style=\\{TAP\\}`));
  assert.match(page, /href=\{CLAIMS_PAGE\} style=\{TAP\}/);
});
