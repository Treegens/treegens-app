import { refundRuleText } from '@/lib/policy';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { PRICING } from '@/lib/impact';
import { publicFacts } from './facts';
import { FindDocuments, FindSubscription, StopByCard, ContactForm } from './tools';

export const metadata = { title: 'Help', description: 'Help for people who sign and people who send, without logging in and without a chatbot. Find your documents, stop a subscription, or write to a person.' };
// The refund window is a setting. Read it when the page is asked for, not when the site is built.
export const dynamic = 'force-dynamic';

const QA = ({ id, q, children }: { id: string; q: string; children: ReactNode }) => (
  <article className="pub-qa" id={id}>
    <h3>{q}</h3>
    {children}
  </article>
);

export default function Help() {
  const { refundDays, dormantStopDays, closeGraceDays } = publicFacts();
  const P = PRICING;
  const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;

  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page">
        <header className="pub-top">
          <h1 className="pub-h1">Help</h1>
          <p className="pub-lead">No chatbot and no login wall. Most things can be fixed right on this page. For everything else, write to us at the bottom and a person replies.</p>
        </header>

        <nav className="pub-jump" aria-label="On this page">
          <a href="#signing"><b>I need to sign something</b><span>Lost links, checking an email is real, deadlines, getting your copy.</span></a>
          <a href="#sending"><b>I send documents</b><span>Cancelling, refunds, how signatures work, fixing a sent document.</span></a>
          <a href="#contact"><b>Write to a person</b><span>Works without logging in. You get a reference.</span></a>
        </nav>

        {/* ---- People who sign ---- */}
        <section aria-labelledby="signing-h" className="pub-section">
          <div className="pub-section-head" id="signing">
            <h2 id="signing-h">I need to sign something</h2>
            <p className="muted">You never need an account or a password to sign, and signing is always free.</p>
          </div>

          <QA id="find-documents" q="I cannot find the email, or my link stopped working">
            <p>Signing links do not wear out. One link works for as long as the document is open, however many times you open it.</p>
            <p>If the email is lost or the link shows an error, enter the address the document was sent to. We email you a link to every document that is waiting for you and every one you have completed.</p>
            <div className="pub-tool">
              <h4>Find my documents</h4>
              <FindDocuments />
            </div>
            <p className="muted small">If the sender corrected the document, your old link was replaced. The page it opens offers to send you the new one.</p>
          </QA>

          <QA id="real" q="Is this email really from Sign&Grow?">
            <p>Every signing request, reminder and completion email has a 12 character security code near the bottom.</p>
            <p>Do not click anything in the email. Type our address into your browser yourself, open <b>Check an email</b> and enter the code. We tell you who sent it and open the document for you.</p>
            <p><Link href="/check" className="btn sm">Check an email</Link></p>
            <p className="muted small">We never ask for a password, a card number or a payment by email.</p>
          </QA>

          <QA id="unexpected" q="I got a request I did not expect">
            <p>You do not have to sign it. If it looks wrong, report it in one of two ways:</p>
            <ul className="pub-list">
              <li>Open the document and choose <b>Report this request</b> on the signing page.</li>
              <li>Or use the contact form on this page with the topic <b>Something looks suspicious</b>.</li>
            </ul>
            <p>Every report goes to a person. When several different people report the same sender, sending from that account is paused until a person has reviewed it.</p>
            <p><a href="#contact" data-topic="suspicious" className="btn sm">Report with the contact form</a></p>
          </QA>

          <QA id="more-time" q="I ran out of time">
            <p>Open your link anyway. If the deadline has passed, the page has a button that asks the sender for more time.</p>
            <p>When the sender reopens the document, the same link works again. Anyone who already signed does not have to sign again.</p>
            <p className="muted small">You can also ask for more time before the deadline, from the signing page.</p>
          </QA>

          <QA id="copy" q="How do I get a copy later?">
            <p>When everyone has finished, each person gets a completion email. It links to the signed document, and the PDF is attached when it is small enough to send.</p>
            <p>Lost that email? Use <a href="#find-documents">Find my documents</a>. It sends the link to the same address again, also months later.</p>
            <p>The link works for as long as the sender keeps their Sign&Grow account. To be safe, download the PDF and keep it. Anyone can confirm it is unchanged at <Link href="/verify">Verify a document</Link>.</p>
          </QA>

          <QA id="while-signing" q="What else can I do on the signing page?">
            <ul className="pub-list">
              <li>Ask the sender a question before you sign.</li>
              <li>Fix the spelling of your own name.</li>
              <li>Pass the document to someone else who should sign instead.</li>
              <li>Decline, with a reason.</li>
              <li>Stop for now and finish later. Your link brings you back to where you were.</li>
              <li>Stop reminder emails for that document.</li>
            </ul>
            <p className="muted small">Asked for an access code? The sender chose it and can tell you what it is. It is never in our email.</p>
          </QA>
        </section>

        {/* ---- People who send ---- */}
        <section aria-labelledby="sending-h" className="pub-section">
          <div className="pub-section-head" id="sending">
            <h2 id="sending-h">I send documents</h2>
            <p className="muted">The plan is month to month. There is no contract and no notice period, and nothing is charged unless you choose it.</p>
          </div>

          <QA id="cancel" q="How do I cancel?">
            <p>There are three ways. Use whichever you can reach.</p>
            <ol className="pub-list">
              <li><b>In the app.</b> Settings, then Plan, then <b>Cancel plan</b>. It is one button. Owners and admins can use it.</li>
              <li><b>From your inbox.</b> While a plan is renewing, every email about a payment (the welcome, each reminder, each receipt) has a link that stops the renewal. It works without logging in.</li>
              <li><b>Without logging in.</b> Use one of the two tools below.</li>
            </ol>
            <div className="pub-tool" id="find-subscription">
              <h4>Find my subscription</h4>
              <p className="muted small">We email you every paid plan tied to your address, each with a link that stops it.</p>
              <FindSubscription />
            </div>
            <div className="pub-tool" id="stop-by-card">
              <h4>Stop billing with my card</h4>
              <p className="muted small">For when you no longer have that mailbox, for example after leaving a job, or do not know which address the account is under. The card proves you are the one paying: its last four digits, plus either the account email or the date and amount of a charge.</p>
              <StopByCard />
            </div>
            <p><b>What happens next.</b> You get a cancellation reference on screen and by email. The plan runs until the end of the month you already paid for, and no payment is taken after that. (If the last payment had failed there is no paid month, so it ends the same day and the failed payment is not tried again.) The signatures you have left stay yours and never expire. Nothing is deleted. If a charge ever arrives after that, the software refunds it by itself and keeps trying until the refund has gone through.</p>
          </QA>

          <QA id="refunds" q="Can I get a refund?">
            <p>Yes, and you do not have to ask anyone. This is the whole rule:</p>
            <ul className="pub-list">
              <li><b>Within {refundDays} days of a payment:</b> {refundRuleText(refundDays)} Each signature is refunded at the price you paid for it. Open Settings, then Plan: your latest payment is offered at the top, and earlier ones in the list of payments. There is no form and no approval.</li>
              <li><b>It covers your latest payment,</b> whether that was the monthly plan or a top-up. Signatures held for envelopes that are still out count as in use until they come back.</li>
              <li><b>Refunding a monthly payment ends the monthly plan.</b> Refunding a top-up changes nothing else.</li>
              <li><b>Charged after you cancelled, charged twice, or charged more than the reminder said:</b> that should never happen. If it does, the software refunds it by itself and tells you. If the payment provider is down at that moment it keeps trying until the refund has gone through.</li>
            </ul>
            <p>The money goes back to the card that paid. Banks usually show it within 5 to 10 working days. Your documents stay where they are.</p>
            <p>Outside this rule, or about an older payment? <a href="#contact" data-topic="billing">Write to us</a> and a person will look at it.</p>
            {dormantStopDays > 0 && <p className="muted small">We also do not charge for a plan nobody uses. If nothing has been sent for {dormantStopDays} days when a renewal comes up, we stop the renewal and tell you, with one click to keep it. You keep your signatures either way.</p>}
          </QA>

          <QA id="signatures" q="How do signatures work, and what is free?">
            <p>A signature is one person signing one envelope. A new account gets {sigs(P.welcomeSignatures)} free to try the product. {P.planName} is ${P.monthlyUsd} a month and adds {sigs(P.monthlySignatures)} with every payment. On {P.planName} you can buy more at ${P.topUpUsd} each, whenever you need them.</p>
            <ul className="pub-list">
              <li><b>Used up:</b> only when someone actually signs.</li>
              <li><b>Held, then given back:</b> sending holds one signature for each signer, so nobody is stopped halfway. If the envelope is voided, declined or left to expire, it comes back by itself.</li>
              <li><b>Always free:</b> signing your own documents. Approvers, viewers and people who get a copy. Reminders, more time and corrections. A signer you add in a correction needs a signature like any other.</li>
              <li><b>Public forms:</b> one signature for each person who signs the form.</li>
            </ul>
            <p>Signatures never expire. What you do not use is still there next month, also after you cancel.</p>
            <p>We email you when you are down to two and when you reach none. With none left, sending pauses until you choose to add more. It never turns into a charge. Signing, downloads and export keep working, and envelopes already out can still be signed.</p>
          </QA>

          <QA id="code" q="I was given a code">
            <p>Some communities get {P.planName} free. Enter your code when you <Link href="/signup">sign up</Link>. If you already have an account, enter it under Settings, then Plan, where it says <b>Have a code?</b></p>
            <p>With a code, the {sigs(P.monthlySignatures)} of the monthly plan arrive every month and nothing is charged. There is no card on file for it and nothing to cancel. If you were paying before, the renewal is stopped for you.</p>
          </QA>

          <QA id="after-cancel" q="What happens to my documents when I cancel?">
            <p>Nothing. Cancelling or a failed payment deletes nothing and locks nothing.</p>
            <p>Every document, audit trail and receipt stays in the account. Documents that are already out can still be signed, and the signatures you have left stay yours.</p>
            <p>You can take everything with you as one ZIP file at any time, on any plan: Settings, then Your data, then <b>Export everything</b>. It is free and it keeps working after you cancel.</p>
          </QA>

          <QA id="close" q="How do I close my account?">
            <p>Closing is separate from cancelling. If you only want to stop paying, cancel the plan and keep your documents.</p>
            <p>To close: Settings, then Your data, then <b>Close my account</b>. Any subscription stops at once.</p>
            <p><b>You have {closeGraceDays} days to undo it.</b> Nothing is deleted during that time. Changed your mind, or closed it by mistake? Sign in again and the account comes straight back.</p>
            <p>After {closeGraceDays} days the account, its documents and its audit trails are removed for good. Export first if you want copies. You can also choose to delete everything immediately.</p>
          </QA>

          <QA id="fix-after-sending" q="I sent a document with a mistake">
            <p>You do not need to void it. Open the envelope and correct it in place: fix a name or an email address, move or add fields, add or remove people.</p>
            <p>Until someone has finished, anything can change. After that, the documents and what that person signed are locked, and everything for the remaining people can still change.</p>
            <p>Signatures already collected stay. People whose part changed get an email that says so. A correction never counts as a new envelope.</p>
          </QA>

          <QA id="not-received" q="The recipient says they never got the email">
            <p>Open the envelope. It shows whether each email left our server, and whether the person has opened the document.</p>
            <ul className="pub-list">
              <li>Copy their signing link and send it yourself by text or chat.</li>
              <li>Send a reminder to just that person.</li>
              <li>Correct their email address. Nothing is voided and nobody else is disturbed.</li>
            </ul>
            <p className="muted small">If a request sits unopened for a couple of days, we email you so you can help before anyone has to ask.</p>
          </QA>

          <QA id="cannot-send" q="Why can I not send?">
            <ul className="pub-list">
              <li><b>Your email address is not confirmed yet.</b> We sent a link when you signed up. The banner at the top of the app sends it again.</li>
              <li><b>The account is in its first week on the free plan.</b> New free accounts can send to a limited number of people a day. Need more right now? <a href="#contact" data-topic="sending">Write to us</a>.</li>
              <li><b>The document reads like a payment notice from a well-known brand with a phone number to call.</b> That is how scams look, so new free accounts cannot send those. If yours is genuine, write to us and a person will clear it.</li>
              <li><b>Sending is paused.</b> This happens when several recipients report documents from one account. A person reviews every pause. Meanwhile you can still open, download and export everything, and documents already out can still be signed. If it is a mistake, <a href="#contact" data-topic="sending">write to us</a>.</li>
              <li><b>You are out of signatures.</b> See <a href="#signatures">how signatures work</a>.</li>
            </ul>
          </QA>

          <QA id="locked-out" q="I cannot log in">
            <p><b>Forgot the password?</b> <Link href="/forgot">Reset it here</Link>. The link we email works for one hour.</p>
            <p><b>No longer have that mailbox?</b> You can still <a href="#stop-by-card">stop the billing with your card</a>. Then <a href="#contact" data-topic="cannot-log-in">write to us</a> and a person will help with the account.</p>
            <p><b>On a team?</b> An owner or admin can remove someone who has left, and that person&apos;s envelopes pass to the team. The owner can hand the whole account to someone else under Settings, then Team.</p>
          </QA>

          <QA id="unknown-charge" q="I see a charge I do not recognise">
            <p>Use <a href="#find-subscription">Find my subscription</a> with each email address you might have used. The email lists every paid plan tied to that address, with a link that stops it.</p>
            <p>If nothing turns up, <a href="#contact" data-topic="billing">write to us</a> with the date and the amount. A person will trace it.</p>
          </QA>
        </section>

        {/* ---- A person ---- */}
        <section aria-labelledby="contact-h" className="pub-section">
          <div className="pub-section-head" id="contact">
            <h2 id="contact-h">Write to a person</h2>
            <p className="muted">This form works whether or not you have an account, and whether or not you can log in. You get a reference straight away, and a person replies by email.</p>
          </div>
          <ContactForm />
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
