import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { securityContacts, contactWords, replyDays } from '@/lib/selfhost';
import { dataPlace, notSaid } from '@/lib/dataplace';
import { PRODUCT } from '@/lib/site';
import { supportReachable } from '@/lib/policy';

export const metadata = { title: 'Reporting a security weakness', description: 'How to tell the people who run this server about a security weakness, and what they have said they will do. Nothing more is promised.' };

// The contact and the reply time are settings (SECURITY_CONTACT, SECURITY_REPLY_DAYS, src/lib/selfhost.ts). This page
// promises only what the operator set there. Without a contact it says who to ask instead, and there is no
// /.well-known/security.txt at all. When nobody reads help requests either (supportReachable in src/lib/policy.ts is
// false: no SUPPORT_EMAIL and no OPERATOR_EMAILS), it says that plainly and sends nobody to a form no person reads.
export const dynamic = 'force-dynamic';

export default function Disclosure() {
  const contacts = securityContacts();
  const days = replyDays();
  const { operator } = dataPlace();
  const support = (process.env.SUPPORT_EMAIL || '').trim();
  const reachable = supportReachable();
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page pub-doc">
        <header className="pub-top">
          <h1 className="pub-h1">Reporting a security weakness</h1>
          <p className="pub-lead">If you found a way to see, change or stop something on this server that you should not be able to, please tell the people who run it. This page says how, and what they have said they will do.</p>
        </header>

        <h2>Who runs this server</h2>
        <p>{operator ? `${operator}.` : notSaid('who they are')} {PRODUCT} is the software. Whoever runs this copy of it decides who reads reports and how fast.</p>

        <h2>Where to write</h2>
        {contacts.length ? (
          <>
            <p>{contacts.length === 1 ? 'Write to ' : 'Write to any of these: '}{contacts.map((c, i) => (
              <span key={c}>{i ? ', ' : ''}<a href={c}>{contactWords(c)}</a></span>
            ))}.</p>
            <p className="muted small">The same contact is published for tools at <a href="/.well-known/security.txt">/.well-known/security.txt</a>.</p>
          </>
        ) : (
          <p>The people who run this server have not set up a contact for security reports. {support
            ? <>Write to <a href={`mailto:${support}`}>{support}</a>, the help address of this server, and start with the words &quot;Security report&quot;.</>
            : reachable
              ? <>Use the <Link href="/help?topic=other#contact">help form</Link> and start with the words &quot;Security report&quot;. It reaches the people who run this server.</>
              : <>Nobody has been set up to read the help form on this server either, so a report sent from here would reach no person. If you know who runs this server, tell them directly, and tell them that this page has no contact.</>}</p>
        )}

        <h2>What helps</h2>
        <ul>
          <li>What you found, and on which page or address.</li>
          <li>The steps to see it again.</li>
          <li>What you think someone could do with it.</li>
          <li>How to reach you, if you want an answer.</li>
        </ul>
        <p>Please use your own account and your own documents to show it. Do not open, copy or change anyone else&apos;s, do not send documents to people who did not ask for them, and stop once you have shown the weakness.</p>

        <h2>What happens next</h2>
        <p>{contacts.length && days
          ? `The people who run this server have said that they answer a report within ${days} ${days === 1 ? 'day' : 'days'} of receiving it. That is their promise, not one the software can keep for them.`
          : 'The people who run this server have not said how soon they answer a report.'}</p>

        <h2>What this page does not promise</h2>
        <ul>
          <li>No reward or payment for a report.</li>
          <li>No permission to test against anyone else&apos;s account or documents.</li>
          <li>No promise about legal action. If you need any of this, ask first and get it in writing from the people who run this server.</li>
        </ul>
        <p className="muted small">What the software does and does not do to protect documents is on <Link href="/security">Security and trust</Link>.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
