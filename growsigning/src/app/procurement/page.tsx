import fs from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { PROCUREMENT_DOCS, writtenOn, sizeWords } from '@/lib/procurement';
import { claimsSummary, CLAIMS_PAGE } from '@/lib/claims';
import { dayText } from '@/lib/dates';
import { PRODUCT } from '@/lib/site';

export const metadata = { title: 'Procurement documents', description: 'The papers a procurement or security team asks for, each with its date. Self-assessed: none of them is an audit.' };

// Every document is read from the docs folder of this server when the page is asked for, so its date is the one
// written in the file that a download sends (src/lib/procurement.ts lists them; src/app/procurement/[doc]/route.ts
// serves them). A document that is not on this server gets a line that says so, never a link that leads nowhere.
export const dynamic = 'force-dynamic';

// A link that stands in a sentence or a list line still gets a 44 px tall target: vertical padding on an inline link
// grows what can be tapped without moving the lines around it.
const TAP = { padding: '13px 0' } as const;

const at = (f: string) => path.join(/* turbopackIgnore: true */ process.cwd(), f);

function docInfo(file: string): { date: string | null; size: number } | null {
  try {
    const text = fs.readFileSync(at(file), 'utf8');
    return { date: writtenOn(text), size: Buffer.byteLength(text) };
  } catch {
    return null;
  }
}

export default function Procurement() {
  // Made by scripts/sbom.mjs when the server is built; a server run from source without a build has none.
  const sbom = fs.existsSync(at('public/security/sbom.json'));
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page pub-doc">
        <header className="pub-top">
          <h1 className="pub-h1">Procurement documents</h1>
          <p className="pub-lead">The papers a procurement or security team usually asks for, written from the code of {PRODUCT} and dated. Each one starts with what it is not.</p>
        </header>

        <h2>Before you read them</h2>
        <ul className="pub-list">
          <li>They are written by the authors of the software about their own code. Nobody outside the project has checked them, and no penetration test has been done.</li>
          <li>They describe the software, not the server you are on. Where its data is and who else handles it are under &quot;Made from this server&apos;s settings&quot; below.</li>
          <li><b>Certifications:</b> {claimsSummary()} <Link href={CLAIMS_PAGE} style={TAP}>The full list</Link>.</li>
        </ul>

        <h2>Documents</h2>
        <p>Each one is a plain text file (.md) that opens in any text editor.</p>
        <ul className="pub-list">
          {PROCUREMENT_DOCS.map((d) => {
            const info = docInfo(d.file);
            return (
              <li key={d.slug}>
                <b>{d.title}.</b> {d.what}
                {info
                  // The same line under every document: its date, then a download that names it (charter P12).
                  ? <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 }}><span className="muted">{info.date ? `Written on ${dayText(info.date)}.` : 'Undated.'}</span><a href={`/procurement/${d.slug}`} download style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Download {d.title} (text file, {sizeWords(info.size)})</a></span>
                  : <span className="muted" style={{ display: 'block' }}>Not on this server: it was installed without its docs folder. The file is in the source of the software, at {d.file}.</span>}
              </li>
            );
          })}
        </ul>

        <h2>Made from this server&apos;s settings</h2>
        <ul className="pub-list">
          <li><Link href="/security/subprocessors" style={TAP}>Sub-processors</Link>: who else handles data on this server, in which country and what for.</li>
          <li><Link href="/security/processing" style={TAP}>Data processing summary</Link>: what is processed, for whom, for how long, and how it is deleted. One page to save as a PDF.</li>
          <li><Link href="/security/disclosure" style={TAP}>Reporting a security weakness</Link>: who to write to, and what they have said they will do.</li>
          {sbom
            ? <li><a href="/security/sbom.json" style={TAP}>Software bill of materials</a> (CycloneDX) and <a href="/security/third-party-licences.txt" style={TAP}>the licence of every package</a>, made when this server was built.</li>
            : <li>Software bill of materials: not on this server, because it was run without a build. Running <code>npm run sbom</code> makes it.</li>}
        </ul>

        <h2>Not here yet</h2>
        <ul className="pub-list">
          <li>No audit report or penetration test report exists.</li>
          <li>No signed contract of any kind. The data processing terms are a template for a lawyer.</li>
        </ul>

        <p className="muted small" style={{ marginTop: 24 }}>Something in these documents that is not true of the code? <Link href="/help?topic=other#contact" style={{ padding: '14px 0' }}>Tell us</Link>.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
