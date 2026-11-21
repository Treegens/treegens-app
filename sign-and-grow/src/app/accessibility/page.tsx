import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { LAST_CHECK, checkedOn, WORKS, NOT_YET, OCR_WARNING, ocrOn } from '@/lib/a11y';
import { supportReachable } from '@/lib/policy';
import { PRODUCT } from '@/lib/site';

export const metadata = { title: 'Accessibility', description: `What works in ${PRODUCT} with a keyboard, a screen reader and zoom, what does not yet, and how to tell us about a problem. Checked by its authors; not audited.` };

// The accessibility statement, in the order public bodies publish theirs: what it covers, what works, what does not
// yet, how to report a problem, and how and when it was checked. The words live in src/lib/a11y.ts so the README and
// docs/acr.md say the same. Two lines follow this server's settings: text from scanned pages (OCR_CMD or
// OCRMYPDF_URL) and whether a person reads help requests (supportReachable); neither promises what is not set up.
export const dynamic = 'force-dynamic';

// A link inside a sentence still gets a 44 px tall target.
const TAP = { padding: '13px 0' } as const;

export default function Accessibility() {
  const reachable = supportReachable();
  const email = (process.env.SUPPORT_EMAIL || '').trim();
  const ocr = ocrOn();
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page pub-doc">
        <header className="pub-top">
          <h1 className="pub-h1">Accessibility</h1>
          <p className="pub-lead">This statement is about {PRODUCT} on this website: the signing page that people open from an email, the screens for sending documents, and the public pages. It says what works, what does not yet, and how to tell us when something is in your way.</p>
        </header>

        <h2>How far it goes</h2>
        <p>We want everyone to be able to sign without help. We have checked the pages ourselves, as described at the end of this page. Nobody outside the project has audited them, so we do not say that {PRODUCT} meets any accessibility standard.</p>

        <h2>What works</h2>
        <ul className="pub-list">
          {WORKS.map((w) => <li key={w}>{w}</li>)}
          {ocr && <li>Pages that are pictures, such as scans, are read by a machine on this server, so a screen reader and search have their text. Beside that text it says: &quot;{OCR_WARNING}&quot;</li>}
        </ul>

        <h2>What does not work yet</h2>
        <ul className="pub-list">
          {NOT_YET.map((w) => <li key={w}>{w}</li>)}
          {!ocr && <li>This server does not read text from scanned pages. If a document you were sent is a scan, ask its sender for a copy with real text, or for a paper copy.</li>}
        </ul>

        <h2>Tell us about a problem</h2>
        {reachable ? (
          <>
            <p>If something on these pages is hard for you to read or use, tell us what you were trying to do and what happened. It becomes a help request that a person reads, and you do not need an account.</p>
            <p><Link href="/help?topic=accessibility#contact" className="btn">Report an accessibility problem</Link></p>
            {email && <p>Or email <a href={`mailto:${email}`} style={TAP}>{email}</a>.</p>}
            <p>If you are signing a document and cannot finish it here, you can also tell its sender: Decline to sign, under Other actions on the signing page, sends them your reason, so they can offer you another way.</p>
          </>
        ) : (
          <p>The people who run this server have not set up help requests, so nobody would read a message sent from this website. If you are signing a document and cannot finish it here, tell its sender: Decline to sign, under Other actions on the signing page, sends them your reason, so they can offer you another way.</p>
        )}

        <h2>How and when it was checked</h2>
        <p>Last checked on {checkedOn()}. {LAST_CHECK.method}</p>
        <p>The authors ran axe-core in a browser on every state of the signing page (access code, consent, the document, the signature box, the stamp box, the check before finishing, done and declined), on the editor and on the page of a sent document, at 320 and 1280 pixels wide. They then signed with the keyboard alone and checked what each field tells a screen reader. The steps are written down with the software, so anyone can repeat them.</p>
        <p>A draft report of how each guideline is met, written by the authors and not audited, is among the <Link href="/procurement" style={TAP}>procurement documents</Link>.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
