import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { CLAIMS, CLAIM_GROUPS, claimStatus, claimSentence } from '@/lib/claims';
import { dataPlace } from '@/lib/dataplace';

export const metadata = { title: 'Certifications', description: 'Every certification, authorization and listing a public buyer may ask about, and whether GrowSigning holds it. One sentence each.' };

// Built from src/lib/claims.ts and from nothing else. No sentence about a certification is written on this page:
// each one is claimSentence() of its entry, so the page cannot say more than the registry does. An entry reads as
// held only with a registry link, a number, a scope and dates that have not run out (claimStatus), and that is
// worked out on every visit, so an entry stops reading as held the day after it expires.
export const dynamic = 'force-dynamic';

const WORD = { held: 'Held', in_progress: 'Not held. Assessment under way', not_held: 'Not held' } as const;

export default function Certifications() {
  const now = new Date();
  const { operator } = dataPlace();
  const held = CLAIMS.filter((c) => claimStatus(c, now) === 'held').length;
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page pub-doc">
        <header className="pub-top">
          <h1 className="pub-h1">Certifications</h1>
          <p className="pub-lead">{held ? `GrowSigning holds ${held} of the ${CLAIMS.length} listed here.` : 'GrowSigning holds none of these today.'} Each line below says so in one sentence.</p>
        </header>
        <p>This list is about GrowSigning: the software, and the service its makers run. {operator ? `This server is run by ${operator}.` : 'Someone else may run the server you are on.'} Whoever runs a server may hold certificates of their own for how they run it. Ask them; this page does not speak for them.</p>
        <p>A line says &quot;holds&quot; only with a number, a scope, the dates and a link to the official register where you can check it yourself. From the day after a certificate runs out, its line says it is not held.</p>

        {CLAIM_GROUPS.map(([group, title]) => (
          <section key={group} aria-labelledby={`claims-${group}`}>
            <h2 id={`claims-${group}`}>{title}</h2>
            <dl className="claims-list">
              {CLAIMS.filter((c) => c.group === group).map((c) => {
                const s = claimStatus(c, now);
                const text = claimSentence(c, now);
                const url = s === 'held' ? c.held!.registry_url : '';
                return (
                  <div key={c.id} id={c.id} style={{ padding: '12px 0', borderTop: '1px solid var(--line, #e4dfd3)' }}>
                    <dt style={{ fontWeight: 700 }}>{c.name} <span className="muted small" style={{ fontWeight: 400 }}>· {WORD[s]}</span></dt>
                    <dd style={{ margin: '4px 0 0' }}>
                      {url ? <>{text.slice(0, text.length - url.length)}<a href={url} rel="noreferrer">{url}</a></> : text}
                      <span className="muted small" style={{ display: 'block', marginTop: 2 }}>What it is: {c.what}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}

        <h2>What you can check instead</h2>
        <p>The code can be run on your own server, so your own security team can test it. <Link href="/security">Security</Link> says what the software does and does not do, <Link href="/security/processing">Data processing</Link> lists every outside service it talks to, and <Link href="/security/disclosure">Report a weakness</Link> says who reads security reports.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
