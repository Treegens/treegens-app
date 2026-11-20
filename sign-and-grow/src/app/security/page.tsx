import type { ReactNode } from 'react';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { publicFacts, abuseFacts } from '@/app/help/facts';
import { CLOSING_REMINDER_DAYS, DELETED_WITH_ACCOUNT, KEPT_AFTER_DELETION, LANGUAGE_NOTE } from '@/lib/policy';
import { WHO_CAN_SEE, NO_BAA_TITLE, NO_BAA_TEXT, NO_BAA_FIRST, NO_BAA_AFTER } from '@/lib/policy';
import { signInProviders, PROVIDER_NAMES } from '@/lib/signin';
import { CHECK_PROVES, CHECK_LIMITS, smsProvider } from '@/lib/checks';
import { SIGNER_CODE_DIGITS, SIGNER_CODE_MINUTES, SIGNER_CODE_TRIES, SIGNER_CODES_PER_HOUR } from '@/lib/policy';
import { SESSION_DAYS, HAND_OVER_TRIES } from '@/lib/policy';
import { IN_PERSON_LOCK, IN_PERSON_LIMITS } from '@/lib/phone';
import { QR_SHOW_SECONDS } from '@/lib/qrlink';
import { WhereYourDataIs } from './DataPlace';
import { BY_SENDER_LINE } from '@/lib/bysender';
import { encryptedFilesPoint, notEncryptedPoint } from '@/lib/storedfiles';

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
  // Google and Microsoft, when the operator of this server has switched them on. Empty when not, and then nothing
  // on this page speaks of them.
  const signIn = signInProviders().map((p) => PROVIDER_NAMES[p]).join(' or ');
  // Whether the operator of this server has switched text messages on. When not, the page says so and offers none.
  const textsOn = !!smsProvider();
  // Whether this server encrypts the files it stores (FILE_ENCRYPTION_KEY). The sentences are in src/lib/storedfiles.ts.
  const encrypted = encryptedFilesPoint();
  const notEncrypted = notEncryptedPoint();
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
            <a href="#who">Who can see your documents</a>
            <a href="#privacy">Privacy and AI</a>
            <a href="#data">Where your data is</a>
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
          {/* What a sender can ask for before a document opens, and what each of them shows about the person. The
              sentences come from src/lib/checks.ts, where the server reads its rules too. A code by text message is
              only spoken of as something you can get here when this server's operator has switched text messages on. */}
          <Point title="A one-time code, when the sender asks for one.">Before the document opens we can send a {SIGNER_CODE_DIGITS}-digit code {textsOn ? 'to your email address, or by text message to a mobile number the sender typed for you' : 'to your email address'}, and you type it in. It is sent only when you press the button, works for {SIGNER_CODE_MINUTES} minutes and for {SIGNER_CODE_TRIES} tries, and the screen shows the address or number with most of it hidden. Until the code is typed, the page shows nothing of the document: not its name, not the message, not who else is on it. If the code never comes, or the number is not yours, a button on the same screen tells the sender, who is the only one who can change it.{textsOn ? '' : ' A code by text message exists in the software, but the operator of this server has not switched text messages on, so nobody is offered it here.'}</Point>
          <Point title="What each check proves, and what it does not.">
            {CHECK_PROVES.map((p) => <span key={p.key} className="pub-proof"><b>{p.title}.</b> {p.text} </span>)}
            <span className="pub-proof">{CHECK_LIMITS}</span>
          </Point>
          {/* A person with no address, whose link the sender passed on (src/lib/bysender.ts): the record says so. */}
          <Point title="A link the sender passed on themselves.">A sender can put someone on a document with a name and no email address, and send them the link by WhatsApp, text message or chat. We never write to that person. The certificate says &quot;{BY_SENDER_LINE}&quot; for them, which shows less than our email does: not how the link travelled, and not who opened it.</Point>
        </Block>

        <Block id="scams" title="Keeping scams out" lead="E-signature services get abused to send fake invoices. These checks are made where a sender starts something that emails a person (a first send, a correction to a document that is out, a reminder, reopening, a bulk send, a public form, a team invitation) and again where the email to the next person in a signing order is written.">
          <Point title="Senders confirm their email address first.">An account cannot send anything or invite anyone until its address is confirmed. The link in the confirmation email works in the browser that signed up. Anywhere else it asks for the password of the login, so the owner of a mailbox cannot confirm a login that someone else made in their name by clicking a link out of habit.</Point>
          <Point title="New accounts have a daily limit.">An account that has not paid for anything can send to {abuse.firstWeekDaily} people a day in its first week and to {abuse.unpaidDaily} a day after that. Everyone a sender newly emails counts, however they are reached. A public form has the same limit of its own, counted for that form alone, so strangers filling in a form never use up what its owner may send. A team can invite {abuse.invitesPerDay} people a day. Paying does not lift the limit at once: it goes when a payment is {abuse.paidTrustDays} days old and was not refunded or disputed. A person on our team can lift it sooner.</Point>
          <Point title="Fake payment notices are stopped.">Until that same day an account cannot send something that reads like a payment notice from a well-known brand with a phone number to call, and cannot send or invite under a name that reads like such a brand. We read what the emails print: the subject, the message, notes to recipients, document names, what the sender wrote on the pages, the reason for voiding, the names the email goes out under and the name of a public form, which its page shows to anyone with the link, also when a brand is glued to another word or spelled with look-alike letters. It is a filter for the common trick, not a guarantee: a scam worded another way passes it, which is what reports are for. A refusal says which words set it off, and a person can clear a genuine sender.</Point>
          <Point title="Every request can be reported.">Each signing email has a report link that needs only its security code, and the signing page has one too. The code still works for a report after the sender has deleted the document. Reports go to a person.</Point>
          <Point title="Enough reports pause the sender.">When {abuse.reportsToPause} different recipients report one account, it is paused until a person has reviewed it. Nothing its senders start is emailed to anyone meanwhile: no new documents, no new or changed recipients, no reminders, no reopening, no invitations and no email about a change, and people further down a signing order are asked only once the pause is lifted. What recipients do themselves still works and is confirmed to them: people who already have a document can sign it, decline it and get their copy. The account keeps access to its own documents. A report from a visitor of a public form reaches a person but does not count towards the pause, because a form takes whatever name and address is typed into it.</Point>
          <Point title="We never ask for money or passwords by email.">Not for a password, not for a card number, not for a payment. An email that does is not from us. <Link href="/help#unexpected">Report it</Link>.</Point>
        </Block>

        <Block id="proof" title="Proof you can check">
          <Point title="Every step is recorded.">Sending, opening, agreeing to sign electronically, signing, declining, corrections and reminders are written to the audit trail with the time and the internet address they came from.</Point>
          <Point title="The audit trail is hash chained.">Each entry includes a fingerprint of the entry before it. Changing or removing an old entry breaks the chain, and the app shows that it is broken.</Point>
          <Point title="Signed PDFs come with a certificate.">The completed document includes a certificate of completion: who signed, when, from where, and the full audit trail. For every signer it says how they were checked before the document opened: a one-time code with the masked address or number it went to and the time it was typed in, an access code, or &ldquo;Link sent by email only&rdquo; when there was no check, so nobody reads more into it than happened.</Point>
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
          <Point title="A signing link opens the document for whoever holds it.">So do the sender&apos;s login and the logins of the owner and admins of the sender&apos;s account. The whole list, with what the people who run this server can see, is under <a href="#who">Who can see your documents</a>. A recipient cannot open a document before their turn. On a public form, typing someone else&apos;s email address never opens their document: an unfinished one is only given back to the browser that started it.</Point>
          {encrypted && <Point title={encrypted.title}>{encrypted.text}</Point>}
          <Point title="A QR code is the link.">The app can show a signing link or the link of a public form as a QR code. The code is drawn in your browser from the link, by our own code: the link is not sent to another service to be turned into a picture. Whoever scans the code, or a photo of it, holds the link. A code for one person&apos;s signing link is taken off the screen again after {QR_SHOW_SECONDS / 60} minutes. A code can do no more than its link: once an address is corrected the old code no longer opens the document, a voided envelope cannot be signed from it, and the code of a paused or deleted form opens a page that says the form is not available.</Point>
        </Block>

        {/* Every sentence of this block is kept in src/lib/policy.ts (WHO_CAN_SEE), with the code that makes it true. */}
        <Block id="who" title="Who can see your documents" lead="In one list, so nobody has to guess. A signing link is the key to its document: read the first line before you forward one.">
          {WHO_CAN_SEE.map((w) => <Point key={w.who} title={w.who}>{w.what}</Point>)}
        </Block>

        <Block id="privacy" title="Privacy and AI">
          <Point title="Your documents are not sent to any AI system.">Nothing you upload or sign is passed to an AI service, and nothing is used to train one.</Point>
          <Point title="Search stays inside your account.">The text of PDFs you upload is indexed so you can search your own envelopes. Files that signers attach are not indexed.</Point>
          <Point title="A file you verify is not stored.">The verify page works out the fingerprint of the file and discards it. In the result, signers&apos; email addresses are partly hidden.</Point>
        </Block>

        {/* Where the server is and who else handles data, read from the settings this server runs on. */}
        <WhereYourDataIs />

        <Block id="access" title="Accounts and access">
          <Point title="Passwords are never stored as written.">Only a salted scrypt hash is kept. Password reset links work once and for one hour.</Point>
          {signIn && <Point title={`With ${signIn}, you are known by the id they have for you, never by an email address alone.`}>When you sign in with {signIn} we check their signed answer ourselves and recognise you by the id it carries for you. An email address in that answer opens a login that already exists only when {signIn} itself confirms to us that the address is yours. Otherwise you sign in with your password once and connect it under Settings, and the owner of a login is emailed whenever a new way to sign in is connected to it.</Point>}
          <Point title="API keys and login sessions are stored as fingerprints.">An API key is shown once, when you create it. After that we only hold its hash.</Point>
          {/* The numbers are the ones the server holds sessions to (src/server/auth.ts reads them from policy.ts). */}
          <Point title="A browser stays signed in while you use it, and you can see where you are signed in.">A browser is signed out {SESSION_DAYS} days after you last used Sign&Grow in it, and every visit starts the {SESSION_DAYS} days again. So a phone you use at least once a month does not ask you to sign in again, and a browser nobody uses is signed out by itself. Signing in on another device signs nothing out. Under Settings, Profile you see every browser that is signed in, with the device and browser it said it was and when it was last used, and you can sign out one of them or all the others at once. Changing your password also signs out every other browser.</Point>
          {/* In-person signing: the lock is src/server/handover.ts, and the sentences are in src/lib/phone.ts. */}
          <Point title="Signing in person locks the host's account on that device.">
            {IN_PERSON_LOCK} After {HAND_OVER_TRIES} wrong passwords that browser is signed out. The signer&apos;s last screen asks them to hand the device back. The lock covers Sign&Grow in that one browser, and nothing else. What the person holding the device could still reach:{' '}
            {IN_PERSON_LIMITS.map((l, i) => <span key={l} className="pub-proof">({i + 1}) {l} </span>)}
            <span className="pub-proof">If that is too much for the person in front of you, send them the document by email and let them sign on a device of their own.</span>
          </Point>
          <Point title="A help request opens with its own link, and only that request.">Our emails about a help request carry a private link that opens that one request without a login, so someone who is locked out can still read the answer and reply. We store only a fingerprint of the secret in the link. Anyone can type any address into the help form, so what was typed is not mailed back or shown on that page until it is known to come from the owner of the address or a person on our team has read it and written back. No API key can read or answer help requests.</Point>
          <Point title="Guessing is slowed down.">Sign-in attempts, access codes, security codes and the public forms on this site are rate limited. An access code is frozen after {abuse.codeTries} wrong tries. A one-time code stops working after {SIGNER_CODE_TRIES} wrong tries, a new one can be asked for once a minute and {SIGNER_CODES_PER_HOUR} times an hour, and the code itself is never stored, only a keyed fingerprint of it.</Point>
          <Point title="Webhooks are signed.">Every delivery carries an HMAC-SHA256 signature you can verify, and webhook addresses that point into a private network are refused.</Point>
          <Point title="Our pages cannot be framed by another site.">That stops a look-alike site from wrapping the real signing screen.</Point>
        </Block>

        <Block id="not" title="What this is not" lead="Being straight about the limits, so you can decide whether this fits." not>
          <Point title="Not certificate-based digital signatures.">A signed PDF is not sealed with a cryptographic certificate inside the file. Its integrity rests on the recorded fingerprint, the audit trail and the verify page.</Point>
          <Point title="Not advanced or qualified signatures.">These are standard electronic signatures with an audit trail. If a law or the other party requires an advanced or a qualified signature, use a service that provides those. For high-stakes documents, ask a lawyer whether a standard electronic signature fits your case and country. <Link href="/help#outside-us">What we know about signing outside the United States, and which documents not to sign here</Link>.</Point>
          <Point title="Not translated yet.">{LANGUAGE_NOTE} That includes the text every signer agrees to before signing, and the certificate.</Point>
          <Point title="No check of identity documents.">We do not look at a passport, an identity card or a face. A signer is known by access to their email inbox, plus an access code or a one-time code {textsOn ? 'by email or by text message' : 'by email'} if the sender asks for one. What each of those proves is said under <a href="#signers">For people who sign</a>.</Point>
          {signIn
            ? <Point title="No two-step login of our own, and no single sign-on for a whole organization.">Accounts are protected by a password, or by signing in with {signIn}. A second step at sign-in is whatever your account there has. We add none of our own, and a team cannot make its members sign in one particular way.</Point>
            : <Point title="No two-step login or single sign-on yet.">Accounts are protected by a password.</Point>}
          <Point title={NO_BAA_TITLE}>{NO_BAA_TEXT} What would have to be true first: {NO_BAA_FIRST.map((x, i) => `(${i + 1}) ${x}`).join(' ')} {NO_BAA_AFTER}</Point>
          <Point title="No payment collection.">Sign&Grow never takes money for a sender. An account that has earned trust can show a link to its own payment page after a person presses Finish, with its name and the full address, and never in an email. We do not see that payment, cannot confirm it and cannot refund it.</Point>
          <Point title="No security certification.">We have not been audited against a security standard, and we will not hint that we have.</Point>
          <Point title={notEncrypted.title}>{notEncrypted.text}</Point>
        </Block>

        <p className="muted" style={{ marginTop: 20 }}>Found a security problem, or something on this page that is not true? <Link href="/help?topic=other#contact">Tell us</Link>. A person reads every message.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
