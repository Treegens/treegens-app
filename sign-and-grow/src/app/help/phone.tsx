import type { ReactNode } from 'react';
import { CANNOT_SHOW_WAYS, OLD_IPHONES, SIGNING_BROWSERS, SIGNING_ONLINE, SIGNING_TESTED, SIGNING_WEAK_SIGNAL, SIGNING_ZOOM } from '@/lib/mobile';

// The answer on /help about signing on a phone: which browsers show the document, what to do when one does not, and
// what the signing page needs from the connection. The words come from src/lib/mobile.ts, which the signing page
// quotes as well, so both say the same.

const QA = ({ id, q, children }: { id: string; q: string; children: ReactNode }) => (
  <article className="pub-qa" id={id}>
    <h3>{q}</h3>
    {children}
  </article>
);

export function SigningOnPhone() {
  return (
    <QA id="phone" q="Can I sign on my phone? Which browsers work?">
      <p>Yes. The link in the email opens the document in your phone&apos;s browser. There is no app to install and no account to make.</p>
      <p><b>Browsers that can show the document.</b> {SIGNING_BROWSERS} {OLD_IPHONES}</p>
      <p className="muted small">{SIGNING_TESTED}</p>
      <p><b>If the page says this browser cannot show the document:</b></p>
      <ul className="pub-list">
        {CANNOT_SHOW_WAYS.map((w) => <li key={w}>{w}</li>)}
      </ul>
      <p><b>A weak signal.</b> {SIGNING_ONLINE} {SIGNING_WEAK_SIGNAL}</p>
      <p><b>Small print.</b> {SIGNING_ZOOM}</p>
    </QA>
  );
}
