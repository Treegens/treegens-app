// Stands in for veraPDF in tests/ds-pdfa.test.ts: VERAPDF_CMD="node tests/pdfa-fake-verapdf.mjs <mode> <log>".
// Answers --version like veraPDF, and "--flavour 2b --format mrr <file>" with a report in veraPDF's machine-readable
// form. mode "pass" passes a file only when it carries what toPdfA writes (the PDF/A-2b XMP and an output intent);
// "fail" fails every file with 3 rules; "slow" never answers; "noversion" cannot say its version. Every call is
// written to <log>, one line each.
import fs from 'node:fs';
import { createRequire } from 'node:module';

// The file is read with pdf-lib, as veraPDF reads it whole: what toPdfA writes can sit in a compressed object stream.
const { PDFDocument, PDFName, PDFRawStream, PDFArray } = createRequire(import.meta.url)('pdf-lib');

const [mode, log, ...args] = process.argv.slice(2);
fs.appendFileSync(log, `${args.join(' ')}\n`);
if (args[0] === '--version') {
  if (mode === 'noversion') process.exit(1);
  console.log('veraPDF 9.9.9\nBuilt: 2026-01-01\nveraPDF Consortium, 2026');
  process.exit(0);
}
if (mode === 'slow') setTimeout(() => {}, 600_000);
else {
  const file = args[args.length - 1];
  const pdf = fs.readFileSync(file).toString('latin1');
  let ok = false;
  if (mode === 'pass') {
    const d = await PDFDocument.load(fs.readFileSync(file), { updateMetadata: false });
    const meta = d.catalog.lookup(PDFName.of('Metadata'));
    const xmp = meta instanceof PDFRawStream ? Buffer.from(meta.contents).toString('utf8') : '';
    const intents = d.catalog.lookup(PDFName.of('OutputIntents'));
    ok = /<pdfaid:part>2<\/pdfaid:part>/.test(xmp) && /<pdfaid:conformance>B<\/pdfaid:conformance>/.test(xmp) && intents instanceof PDFArray && String(intents.lookup(0).get(PDFName.of('S'))) === '/GTS_PDFA1' && d.context.trailerInfo.ID instanceof PDFArray;
  }
  const failed = ok ? 0 : 3;
  console.log(`<?xml version="1.0" encoding="utf-8"?>
<report><buildInformation><releaseDetails id="core" version="9.9.9" buildDate="2026-01-01T00:00:00Z"/></buildInformation>
<jobs><job><item size="${pdf.length}"><name>${file}</name></item>
<validationReport jobEndStatus="normal" profileName="PDF/A-2B validation profile" statement="${ok ? 'PDF file is compliant with Validation Profile requirements.' : 'PDF file is not compliant with Validation Profile requirements.'}" isCompliant="${ok}">
<details passedRules="140" failedRules="${failed}" passedChecks="1000" failedChecks="${failed}">${ok ? '' : '<rule specification="ISO 19005-2:2011" clause="6.6.2.1" testNumber="1" status="failed" failedChecks="1"><description>Metadata</description></rule><rule specification="ISO 19005-2:2011" clause="6.2.3" testNumber="2" status="failed" failedChecks="1"><description>Output intent</description></rule><rule specification="ISO 19005-2:2011" clause="6.2.11.4.1" testNumber="1" status="failed" failedChecks="1"><description>Fonts</description></rule>'}</details>
</validationReport></job></jobs></report>`);
  process.exit(ok ? 0 : 1);
}
