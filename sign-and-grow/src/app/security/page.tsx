import type { ReactNode } from 'react';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { publicFacts, abuseFacts } from '@/app/help/facts';
import { CLOSING_REMINDER_DAYS, DELETED_WITH_ACCOUNT, KEPT_AFTER_DELETION } from '@/lib/policy';

export const metadata = { title: 'Security and trust', description: 'What Sign&Grow does to protect signers, senders and documents, in plain words. And what it does not do.' };

// The daily limits and the number of reports that pause an account are settings. Read them when the page is asked
// for, not when the site is built.
export const dynamic = 'force-dynamic';

// Every statement on this page describes behaviour that exists in the code today. Before adding a line, find the
// code that makes it true. If you cannot, it does not belong here.

const Point = ({ title, children }: { title: string; children: ReactNode }) => (
  <li><b>{title}</b><span>{children}</span></li>
);

const Block = ({ id, title, lead, not, children }: { id: string; title: string; lead?: string; not?: boolean; children: ReactNode }) => (
  <section className={`card pub-trust${not ? ' not' : ''}`} id={id} aria-labelledby={`${id}-h`}>
    <h2 id={`${id}-h`}>{title}</h2>
    {lead && <p className="muted">{lead}</p>}
    <ul className={`pub-points${not ? ' not' : ''}`}>{children}</ul>
  </section>
);

export default function Security() {
  const { closeGraceDays } = publicFacts();
  const abuse = abuseFacts();
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page">
        <header className="pub-top">
          <h1 className="pub-h1">Security and trust</h1>
          <p className="pub-lead">This page says what the software does today, in plain words. It also says what it does not do. If something is not written here, do not assume it.</p>
          <nav className="pub-toc" aria-label="On this page">
            <a href="#signers">For people who sign</a>
            <a href="#scams">Keeping scams out</a>
            <a href="#proof">Proof you can check</a>
            <a href="#your-documents">Your documents stay yours</a>
            <a href="#privacy">Privacy and AI</a>
            <a href="#access">Accounts and access</a>
            <a href="#not">What this is not</a>
          </nav>
        </header>

        <Block id="signers" title="For people who sign">
          <Point title="You never need an account or a password.">The link in your email is all you need. Nobody is asked to register, log in or start a trial in order to sign.</Point>
          <Point title="You are never sent marketing.">We email signers only about documents they are part of: the request, reminders, changes and the completed copy. You can switch off reminders for a document with one click.</Point>
          <Point title="Your link does not wear out.">It works for as long as the document is open, however many times you open it. There is no limit on clicks. If a deadline passes, the sender can reopen the document and the same link works again.</Point>
          <Point title="You can check that an email is real.">Signing requests, reminders and completion emails carry a security code. Type it in at <Link href="/check">Check an email</Link> and we tell you which address sent it and under what name. You can report the email there too, without opening the document.</Point>
          <Point title="You always know who is asking.">Each request names the sender and their email address, and a reply goes straight to that person.</Point>
          <Point title="You get your copy, also later.">Everyone on a document gets the completed PDF. <Link href="/help#find-documents">Find my documents</Link> sends the link again to the same inbox, for as long as the sender keeps their account. A sender who deletes a completed document only takes it out of their own lists: your link and your copy stay.</Point>
          <Point title="Extra protection when the sender wants it.">A sender can put an access code of at least {abuse.codeMin} characters on a document. They give it to you themselves. It is never in our email. After {abuse.codeTries} wrong tries the code is frozen, so it cannot be guessed, until the sender sets a new one.</Point>
        </Block>

        <Block id="scams" title="Keeping scams out" lead="E-signature services get abused to send fake invoices. These checks run whenever a sender causes an email to someone: a first send, a correction to a document that is out, a reminder, a bulk send and a public form.">
          <Point title="Senders confirm their email address first.">An account cannot send anything until its address is confirmed.</Point>
          <Point title="Accounts that have not paid have a daily limit.">An account that has not paid for anything can send to {abuse.firstWeekDaily} people a day in its first week and to {abuse.unpaidDaily} a day after that. Everyone newly emailed counts, however they are reached. A payment lifts the limit, and so can a person on our team.</Point>
          <Point title="Fake payment notices are stopped.">An account that has not paid cannot send something that reads like a payment notice from a well-known brand with a phone number to call, and cannot send under a name that reads like such a brand. We read the subject, the message, notes to recipients, document names and the names the email goes out under, also when they are spelled with look-alike letters. It is a filter for the common trick, not a guarantee. A person can clear a genuine sender.</Point>
          <Point title="Every request can be reported.">Each signing email has a report link that needs only its security code, and the signing page has one too. Reports go to a person.</Point>
          <Point title="Enough reports pause the sender.">When {abuse.reportsToPause} different recipients report one account, everything it sends stops until a person has reviewed it: new documents, new or changed recipients, reminders and reopening. People who already have a document can still sign it, and the account keeps access to its own documents meanwhile.</Point>
          <Point title="We never ask for money or passwords by email.">Not for a password, not for a card number, not for a payment. An email that does is not from us. <Link href="/help#unexpected">Report it</Link>.</Point>
        </Block>

        <Block id="proof" title="Proof you can check">
          <Point title="Every step is recorded.">Sending, opening, agreeing to sign electronically, signing, declining, corrections and reminders are written to the audit trail with the time and the internet address they came from.</Point>
          <Point title="The audit trail is hash chained.">Each entry includes a fingerprint of the entry before it. Changing or removing an old entry breaks the chain, and the app shows that it is broken.</Point>
          <Point title="Signed PDFs come with a certificate.">The completed document includes a certificate of completion: who signed, when, from where, and the full audit trail.</Point>
          <Point title="Anyone can verify a signed PDF.">Drop the file on <Link href="/verify">Verify a document</Link>. We compare its SHA-256 fingerprint with the one recorded when signing finished. One changed byte and it no longer matches. No account is needed, and the file is not kept.</Point>
        </Block>

        <Block id="your-documents" title="Your documents stay yours">
          <Point title="Export everything, free, at any time.">One ZIP file with every signed PDF, every audit trail and a list of all envelopes. It is free on every plan and keeps working after you cancel.</Point>
          <Point title="Stopping payment never costs you your documents.">Cancelling, a failed payment or moving to the free plan deletes nothing and locks nothing. A paused account can still open, download and export everything.</Point>
          <Point title={`Closing an account can be undone for ${closeGraceDays} days.`}>Nothing is deleted during that time, and signing in again brings the account straight back. While it is closing nothing new starts in it: nothing is sent, nobody joins, and its API keys are off. {CLOSING_REMINDER_DAYS} days before the end the owner is emailed the date, how to keep the account and how to export everything first.</Point>
          <Point title="Deleted means deleted.">When an account is deleted, at once or after the {closeGraceDays} days, this goes for good. {DELETED_WITH_ACCOUNT.join(' ')}</Point>
          <Point title="What stays after a deletion, and why.">{KEPT_AFTER_DELETION.join(' ')}</Point>
          <Point title="A team does not lose documents when someone leaves.">What they sent (envelopes, drafts, templates and bulk sends) passes to a member an admin chooses, each envelope&apos;s audit trail says who handed it to whom, and the owner can hand the account to someone else. The person who was removed keeps their login and gets a workspace of their own.</Point>
          <Point title="Templates are shared, not up for grabs.">Everyone on a team can use every template. Only the person it belongs to and the admins can change or delete it. Members see their own envelopes, folders and bulk sends, and admins see all of them.</Point>
          <Point title="Only the right people can open a document.">The people it was sent to, the person who sent it, and the admins of the sender&apos;s account. A recipient cannot open it before their turn, or after it has been voided, declined or left to expire. On a public form, typing someone else&apos;s email address never opens their document: an unfinished one is only given back to the browser that started it.</Point>
        </Block>

        <Block id="privacy" title="Privacy and AI">
          <Point title="Your documents are not sent to any AI system.">Nothing you upload or sign is passed to an AI service, and nothing is used to train one.</Point>
          <Point title="Search stays inside your account.">The text of PDFs you upload is indexed so you can search your own envelopes. Files that signers attach are not indexed.</Point>
          <Point title="A file you verify is not stored.">The verify page works out the fingerprint of the file and discards it. In the result, signers&apos; email addresses are partly hidden.</Point>
        </Block>

        <Block id="access" title="Accounts and access">
          <Point title="Passwords are never stored as written.">Only a salted scrypt hash is kept. Password reset links work once and for one hour.</Point>
          <Point title="API keys and login sessions are stored as fingerprints.">An API key is shown once, when you create it. After that we only hold its hash.</Point>
          <Point title="Guessing is slowed down.">Sign-in attempts, access codes, security codes and the public forms on this site are rate limited. An access code is frozen after {abuse.codeTries} wrong tries.</Point>
          <Point title="Webhooks are signed.">Every delivery carries an HMAC-SHA256 signature you can verify, and webhook addresses that point into a private network are refused.</Point>
          <Point title="Our pages cannot be framed by another site.">That stops a look-alike site from wrapping the real signing screen.</Point>
        </Block>

        <Block id="not" title="What this is not" lead="Being straight about the limits, so you can decide whether this fits." not>
          <Point title="Not certificate-based digital signatures.">A signed PDF is not sealed with a cryptographic certificate inside the file. Its integrity rests on the recorded fingerprint, the audit trail and the verify page.</Point>
          <Point title="Not advanced or qualified signatures.">These are standard electronic signatures with an audit trail. If a law or the other party requires an advanced or a qualified signature, use a service that provides those. For high-stakes documents, ask a lawyer whether a standard electronic signature fits your case and country.</Point>
          <Point title="No identity check yet.">We do not check ID documents and we do not send codes by SMS or phone. A signer is identified by access to their email inbox, plus an access code if the sender sets one.</Point>
          <Point title="No two-step login or single sign-on yet.">Accounts are protected by a password.</Point>
          <Point title="No security certification.">We have not been audited against a security standard, and we will not hint that we have.</Point>
          <Point title="No claim about encrypted storage.">The software does not add its own encryption to stored documents. How the disk is protected depends on where the service is hosted.</Point>
        </Block>

        <p className="muted" style={{ marginTop: 20 }}>Found a security problem, or something on this page that is not true? <Link href="/help?topic=other#contact">Tell us</Link>. A person reads every message.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
