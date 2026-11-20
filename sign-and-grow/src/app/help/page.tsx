import { refundRuleText, priceRuleText, CLOSING_REMINDER_DAYS, DELETED_WITH_ACCOUNT, KEPT_AFTER_DELETION } from '@/lib/policy';
import { BULK_COST_NOTE, NO_BAA_TITLE, NO_BAA_TEXT, NO_BAA_FIRST, NO_BAA_AFTER, reminderText, DEFAULT_REMINDER_DAYS } from '@/lib/policy';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { PRICING, usd, CURRENCY_NOTE } from '@/lib/impact';
import { signInProviders, PROVIDER_NAMES } from '@/lib/signin';
import { CHECK_PROVES, CHECK_LIMITS, smsProvider } from '@/lib/checks';
import { SIGNER_CODE_DIGITS, SIGNER_CODE_MINUTES, SIGNER_CODE_TRIES, SIGNER_CODES_PER_HOUR, smsDailyPerAccount } from '@/lib/policy';
import { mailEventsOn, BOUNCE_MEANS, BOUNCE_STOPS, COMPLAINT_MEANS, SOFT_BOUNCE_DAYS } from '@/lib/policy';
import { publicFacts, abuseFacts, supportFacts } from './facts';
import { replyPromise } from '@/lib/support';
import { FindDocuments, FindSubscription, StopByCard, ContactForm, YourRequests, ReplyRecord, FindRequests } from './tools';
import { ConsentWords, SignatureKind } from './outside';
import { WitnessHelp } from './witness';
import { SigningOnPhone } from './phone';
import { NotMeAnswer } from './NotMe';
import { PAY_FOR_SENDER, payNotYet } from '@/lib/paylink';
import { PAID_TRUST_DAYS } from '@/lib/policy';
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS, GROUP_RULE } from '@/lib/policy';
import { TWO_STEP_LOST, TWO_STEP_TRIES, TWO_STEP_PAUSE_MINUTES } from '@/lib/policy';

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
  const abuse = abuseFacts();
  // Google and Microsoft, when the operator of this server has switched them on. Empty when not, and then the page
  // does not speak of them.
  const signInWith = signInProviders().map((p) => PROVIDER_NAMES[p]).join(' or ');
  const support = supportFacts();
  // Whether the operator of this server has switched text messages on. When not, the page offers none and says why.
  const textsOn = !!smsProvider();
  // Whether this server hears from its mail provider what became of an email (MAIL_EVENTS_TOKEN). Not said when not.
  const bouncesOn = mailEventsOn();
  const smsDaily = smsDailyPerAccount();
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
          <a href="#contact"><b>Write to a person</b><span>Works without logging in. You get a reference{support.promised ? ' and the time by which a person will have answered' : ''}.</span></a>
        </nav>

        {/* ---- People who sign ---- */}
        <section aria-labelledby="signing-h" className="pub-section">
          <div className="pub-section-head" id="signing">
            <h2 id="signing-h">I need to sign something</h2>
            <p className="muted">You never need an account or a password to sign, and signing is always free.</p>
          </div>

          <QA id="find-documents" q="I cannot find the email, or my link stopped working">
            <p>Signing links do not wear out. One link works for as long as the document is open, however many times you open it.</p>
            <p>If the email is lost or the link shows an error, enter the address the document was sent to. We email you a link to every document that is waiting for you, every one you have signed (also while others have not finished) and every completed one. If more than one person uses the address, each link says who it is for. One email holds 50 documents: if there are more, it says how many and how to get the rest.</p>
            <div className="pub-tool">
              <h4>Find my documents</h4>
              <FindDocuments />
            </div>
            <p className="muted small">If the sender corrected the document, your old link was replaced. The page it opens offers to send you the new one.</p>
            <p className="muted small">Did the sender send you the link themselves, by WhatsApp, text message or chat, and not by email from us? Then we have no address for you and this cannot find it. Ask the sender: the envelope page shows your link to them, also after everyone has signed.</p>
          </QA>

          <QA id="real" q="Is this email really from Sign&Grow?">
            <p>Every signing request, reminder and completion email has a 12 character security code near the bottom.</p>
            <p>Do not click anything in the email. Type our address into your browser yourself, open <b>Check an email</b> and enter the code. We tell you who sent it and open the document for you.</p>
            <p><Link href="/check" className="btn sm">Check an email</Link></p>
            <p className="muted small">We never ask for a password, a card number or a payment by email.</p>
          </QA>

          <QA id="unexpected" q="I got a request I did not expect">
            <p>You do not have to sign it. If it looks wrong, report it in one of three ways:</p>
            <ul className="pub-list">
              <li>Without opening anything: choose <b>Report this email</b> in the email, or type its security code into <Link href="/check">Check an email</Link> and report it there.</li>
              <li>Or open the document and choose <b>Report this request</b> on the signing page.</li>
              <li>Or use the contact form on this page with the topic <b>Something looks suspicious</b>.</li>
            </ul>
            <p>Every report goes to a person. When {abuse.reportsToPause} different people who were sent documents report the same sender, sending from that account is paused until a person has reviewed it: nothing its senders start is emailed to anyone, and people further down a signing order are not asked. You can report an email with its security code also after the sender has deleted the document. A report from someone who filled in a public form goes to a person too, but does not count towards that number, because a form takes whatever name and address is typed into it.</p>
            <p><a href="#contact" data-topic="suspicious" className="btn sm">Report with the contact form</a></p>
          </QA>

          <QA id="not-me" q="I am named on a document I did not sign"><NotMeAnswer /></QA>

          <QA id="more-time" q="I ran out of time">
            <p>Open your link anyway. If the deadline has passed, the page has a button that asks the sender for more time.</p>
            <p>When the sender reopens the document, the same link works again. Anyone who already signed does not have to sign again.</p>
            <p className="muted small">You can also ask for more time before the deadline, from the signing page.</p>
          </QA>

          <QA id="copy" q="How do I get a copy later?">
            <p>When everyone has finished, each person gets a completion email. It links to the signed document, and the PDF is attached when it is small enough to send.</p>
            <p>Lost that email? Use <a href="#find-documents">Find my documents</a>. It sends the link to the same address again, also months later.</p>
            <p>The link works for as long as the sender keeps their Sign&Grow account. A sender who deletes a completed document only removes it from their own lists: your link and your copy stay. To be safe, download the PDF and keep it. Anyone can confirm it is unchanged at <Link href="/verify">Verify a document</Link>.</p>
          </QA>

          <QA id="while-signing" q="What else can I do on the signing page?">
            <ul className="pub-list">
              <li>Ask the sender a question before you sign, under Questions and comments. Only the sender and the admins of their account read it, unless you choose everyone on the document, and their answer appears on the same page and comes by email. Comments are not printed on the document and are not part of what you sign.</li>
              <li>Fix a slip in the spelling of your own name. A small one, such as a letter missing or two swapped, a space, a hyphen or a dot, is corrected at once. When the software cannot tell that the new name is still you, for example a name written in another alphabet, it changes nothing and asks the sender, who can correct it for you.</li>
              <li>Pass the document to someone else who should sign instead.</li>
              <li>Decline, with a reason.</li>
              <li>Stop for now and finish later. Your link brings you back to where you were.</li>
              <li>Stop reminder emails for that document.</li>
            </ul>
            <p className="muted small">Asked for an access code? The sender chose it and can tell you what it is. It is never in our email. The page that asks for it has an <b>Ask the sender</b> button. After {abuse.codeTries} wrong tries a code is frozen so it cannot be guessed, and the sender sets a new one.</p>
          </QA>
          <SigningOnPhone />

          <QA id="group-taken" q="It says a colleague has taken this on">
            <p>The document was sent to a group you are in, and any one of you can act on it. The first person who agreed to sign took it on, so your link now says who has it, and you do not need to do anything. If you should do it instead, for example because they are away, press the button on your link that asks the sender to give it back. Only the sender can do that. If you took it on by mistake, open <b>Other actions</b> and choose <b>Hand back</b> before you finish: it goes back to the whole group, and what you filled in is cleared.</p>
          </QA>
          <QA id="one-time-code" q="I was asked for a one-time code">
            <p>The sender asked us to check who opens the document. When you press <b>Send me the code</b> we send a {SIGNER_CODE_DIGITS}-digit code {textsOn ? 'to your email address, or by text message to a mobile number the sender typed for you' : 'to your email address'}. The screen shows where it goes with most of it hidden. Type the code in and the document opens. On that device it stays open for a day.</p>
            <ul className="pub-list">
              <li>A code works for {SIGNER_CODE_MINUTES} minutes and for {SIGNER_CODE_TRIES} tries. Only the newest one works.</li>
              <li>You can ask for a new code after a minute, up to {SIGNER_CODES_PER_HOUR} times an hour. The button says when.</li>
              <li><b>The code does not arrive?</b> A code by email goes to the same mailbox as the link, so look in the spam folder.{textsOn ? ' A text can take a minute.' : ''} If it still does not come, <b>I do not get the code</b> on the same screen tells the sender.</li>
              {textsOn && <li><b>The number is not yours?</b> Press <b>This is not my number</b>. We stop texting it at once, codes and links alike, and tell the sender.</li>}
              <li>Only the sender can change where the code goes, or take the check off. We cannot do that for you, because we cannot know who is asking.</li>
            </ul>
            <p className="muted small">Nobody at Sign&Grow will ever ask you for this code, and neither should the sender. If a code arrives that you did not ask for, someone else has opened your link: do not pass the code on.</p>
          </QA>
          <ConsentWords />
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
            <p><b>What happens next.</b> You get a cancellation reference on screen and by email. The plan runs until the end of the month you already paid for, and no payment is taken after that. (If the last payment had failed there is no paid month, so it ends the same day and the failed payment is not tried again.) The signatures you have left stay yours and never expire. Nothing is deleted. If a charge ever arrives after that, the software refunds it by itself and tells you. If the payment provider refuses that refund three times, a person here sends it by hand and we tell you so.</p>
          </QA>

          <QA id="refunds" q="Can I get a refund?">
            <p>Yes, and you do not have to ask anyone. This is the whole rule:</p>
            <ul className="pub-list">
              <li><b>Within {refundDays} days of a payment:</b> {refundRuleText(refundDays)} Each signature is refunded at the price you paid for it. Open Settings, then Plan: your latest payment is offered at the top, and earlier ones in the list of payments. There is no form and no approval.</li>
              <li><b>It covers every payment inside that time,</b> the monthly plan and top-ups alike, and you can come back for more: signatures held for envelopes that are still out count as in use, and when they come back (a voided envelope, say) they can be refunded too.</li>
              <li><b>Refunding a monthly payment ends the monthly plan.</b> Refunding a top-up changes nothing else.</li>
              <li id="price"><b>If the price ever changes:</b> {priceRuleText()}</li>
              <li><b>Charged after you cancelled, charged twice, or charged more than the reminder said:</b> that should never happen. If it does, the software refunds it by itself and tells you. If the payment provider is down at that moment it keeps trying until the refund has gone through; if the provider refuses it three times, a person here sends it by hand and we tell you so.</li>
            </ul>
            <p>The money goes back to the card that paid. Banks usually show it within 5 to 10 working days. Your documents stay where they are.</p>
            <p>Outside this rule, or about an older payment? <a href="#contact" data-topic="billing">Write to us</a> and a person will look at it.</p>
            {dormantStopDays > 0 && <p className="muted small">We also do not charge for a plan nobody uses. If nothing has been sent for {dormantStopDays} days when a renewal comes up, we stop the renewal and tell you, with one click to keep it. You keep your signatures either way.</p>}
          </QA>

          <QA id="signatures" q="How do signatures work, and what is free?">
            <p>A signature is one person signing one envelope. A new account gets {sigs(P.welcomeSignatures)} free to try the product. {P.planName} is {usd(P.monthlyUsd)} a month and adds {sigs(P.monthlySignatures)} with every payment. On {P.planName} you can buy more at {usd(P.topUpUsd)} each, whenever you need them. {CURRENCY_NOTE}</p>
            <ul className="pub-list">
              <li><b>Used up:</b> only when someone actually signs.</li>
              <li><b>Held, then given back:</b> sending holds one signature for each signer, so nobody is stopped halfway. If the envelope is voided, declined or left to expire, the ones held for people who had not signed yet come back by themselves. One that was already used stays used.</li>
              <li><b>Always free:</b> signing your own documents. Approvers, viewers and people who get a copy. Reminders, more time and corrections. A signer you add in a correction needs a signature like any other.</li>
              <li><b>Public forms:</b> one signature for each person who signs the form.</li>
              <li id="bulk-cost"><b>Bulk send:</b> {BULK_COST_NOTE} A list of 40 people needs 40 signatures before it is sent. The bulk send page shows how many a list holds, how many you have, what is missing and what that costs, before you press Send. An account that has not paid yet can also newly email only {abuse.firstWeekDaily} people a day in its first week and {abuse.unpaidDaily} a day after that.</li>
            </ul>
            <p>Signatures never expire. What you do not use is still there next month, also after you cancel.</p>
            <p>We email you when you are down to two and when you reach none. With none left, sending pauses until you choose to add more. It never turns into a charge. Signing, downloads and export keep working, and envelopes already out can still be signed.</p>
          </QA>

          <QA id="code" q="I was given a code">
            <p>Some communities get {P.planName} free. Enter your code when you <Link href="/signup">sign up</Link>. If you already have an account, enter it under Settings, then Plan, where it says <b>Have a code?</b></p>
            <p>With a code, the {sigs(P.monthlySignatures)} of the monthly plan arrive every month and nothing is charged for the plan, so there is nothing to cancel. If you were paying before, your paid subscription ends the moment the code is applied, with a cancellation reference by email; the card you paid with stays saved for top-ups until you remove it on the Plan page.</p>
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
            <p>While it is closing, nothing new starts in it: nothing can be sent, nobody can be invited or join, and its API keys are switched off. People who already have a document can still sign it. {CLOSING_REMINDER_DAYS} days before the end we email you the date, how to keep the account and how to take a copy of everything first.</p>
            <p>After {closeGraceDays} days it is removed for good. Export first if you want copies. You can also choose to delete everything immediately. <b>What is deleted:</b></p>
            <ul className="pub-list">{DELETED_WITH_ACCOUNT.map((x) => <li key={x}>{x}</li>)}</ul>
            <p><b>What is kept:</b></p>
            <ul className="pub-list">{KEPT_AFTER_DELETION.map((x) => <li key={x}>{x}</li>)}</ul>
          </QA>

          <QA id="fix-after-sending" q="I sent a document with a mistake">
            <p>You do not need to void it. Open the envelope and correct it in place: fix a name or an email address, move or add fields, add or remove people.</p>
            <p>Until someone has finished, anything can change. After that, you can still fix names, email addresses and the signing order of the people who are left. A change to the pages themselves (a different file, new wording, a field added, moved or removed, or a name or address that a field prints on the page) is only saved if you choose to ask the people who already finished to sign again. You are asked first, in plain words, and nothing is saved if you say no. When a name is printed on pages someone has signed, make that change with Edit envelope, where the question is asked: the quick Correct next to a name says so and changes nothing.</p>
            <p>Signatures already collected stay unless you make that choice, and so does what a signer who has finished left empty or unticked. People whose part changed get an email that says what changed, and a signing page that is open at that moment loads the changed document before anyone can finish on it. Someone who is asked to sign again keeps their link, their first signature stays on record with the document as they signed it, which they can still download, and it does not use another signature. A correction never counts as a new envelope, and the audit trail says what each one changed.</p>
          </QA>

          <QA id="not-received" q="The recipient says they never got the email">
            <p>Open the envelope. It shows whether each email left our server, and whether the person has opened the document.</p>
            <ul className="pub-list">
              <li>Copy their signing link and send it yourself by text or chat. If they are standing next to you, show it as a QR code instead (&quot;Show QR code&quot; on the envelope) and they open it with their phone camera. The code is the link, so show it only to them.</li>
              <li>Send a reminder to just that person.</li>
              <li>Correct their email address. Nothing is voided and nobody else is disturbed.</li>
            </ul>
            <p className="muted small">If a request sits unopened for a couple of days, we email you so you can help before anyone has to ask.</p>
            <p className="muted small">Someone who has no email address, or does not read it, can be on an envelope without one: <a href="#no-email">tick &quot;I will send the link myself&quot;</a> and send them the link from the envelope page.</p>
            {textsOn && <p className="muted small">You can also have us text the signing link: under <b>More</b> next to a recipient, type their mobile number and tick <b>Also text the signing link</b>. It is off unless you choose it, the text names you and the document, and reminders by text follow at most once a day.</p>}
          </QA>

          {bouncesOn && (
            <QA id="bounced" q="An envelope says &quot;Could not be delivered&quot; or &quot;Marked as spam&quot;">
              <p><b>Could not be delivered.</b> {BOUNCE_MEANS} We email you at once, and the envelope says it next to the person&apos;s name. {BOUNCE_STOPS}</p>
              <ul className="pub-list">
                <li>Address wrong? Choose <b>Correct</b> next to their name and type the right one. A new email goes out at once, and nothing is voided.</li>
                <li>Address right, and the mailbox works again (it was full, or switched off for a while)? Choose <b>Try again</b>. We email them again at once and reminders start again. If it comes back again, you hear it again.</li>
                <li>Either way you can copy their signing link and send it yourself, by text or chat.</li>
              </ul>
              <p><b>Not delivered yet</b> means their mail server asked us to try later, often because the mailbox is full. Nothing is stopped. If the same address says that on {SOFT_BOUNCE_DAYS} separate days, we treat it as an address that does not work.</p>
              <p><b>Delivered to the mail server of example.com</b> means their mail server took the email. It does not mean they read it, and it may still be in a spam folder.</p>
              <p><b>Marked as spam.</b> {COMPLAINT_MEANS} You cannot undo that for them, but you can still give them their link yourself.</p>
              <p className="muted small">When our emails to your own address come back, the app says so at the top of every page. Choose &quot;It works now, try again&quot;, or move your login to an address that works under Settings, Profile.</p>
            </QA>
          )}

          <QA id="checking-signers" q="How can I check who is signing?">
            <p>Under <b>More</b> next to each recipient you choose what they have to do before the document opens: nothing, an access code you give them yourself, {textsOn ? 'a one-time code we send to their email address, or a one-time code we send by text message to a mobile number you type' : 'or a one-time code we send to their email address'}. An access code can be combined with a one-time code. What each of them proves:</p>
            <ul className="pub-list">
              {CHECK_PROVES.filter((p) => textsOn || p.key !== 'sms_code').map((p) => <li key={p.key}><b>{p.title}.</b> {p.text}</li>)}
            </ul>
            <p>{CHECK_LIMITS}</p>
            <p>You can change a person&apos;s check or number while the envelope is out: <b>Correct</b> next to their name. They then have to pass the check again, and the audit trail says what you changed. If you send the document to another person, a number you typed for the first one is never used for the second: you are asked for it again. A template keeps its check, a bulk send takes a <b>phone</b> column, and a public form can ask its visitors for a code by email only, because they type their own details.</p>
            {textsOn
              ? <p className="muted small">Text messages are not charged to you. To keep them from being misused, one account can send {smsDaily} in 24 hours, every code and every reminder counted, and an account under the daily limit on emails can text as many phone numbers a day as people it can email. A text that could not be delivered shows on the envelope, and you are told when we stop trying.</p>
              : <p className="muted small">The software can also send a one-time code by text message and text the signing link. The operator of this server has not switched text messages on, so they are not offered here.</p>}
          </QA>

          {/* A witness for one signer, what it records and what it cannot check, with its dated source (help/witness.tsx). */}
          <WitnessHelp />

          <QA id="reminders" q="Are people reminded by themselves?">
            <p>On an account made today, yes. It starts with a reminder every {DEFAULT_REMINDER_DAYS} days: {reminderText(DEFAULT_REMINDER_DAYS).replace(/^Automatic reminders are on: /, '')}</p>
            <p>You see the setting on the last step before every send and can change it there for that one envelope, or switch it off. An owner or admin sets what new envelopes start with under Settings, then Account. An account that was made before reminders were on by default keeps the number it had, which may be none: the last step before sending says which.</p>
            <p>A reminder to someone who has filled in everything and only has to press Finish says exactly that, and the envelope page shows you who is at that point. Reminders are sent by the service&apos;s own timer, so one can arrive a little after it is due, and none go out while sending is paused on an account.</p>
          </QA>

          <SignatureKind />

          {/* The same words as on /security and under the pricing rules: NO_BAA_* in src/lib/policy.ts. */}
          <QA id="patient-information" q="Can I use it for patient forms or other health information?">
            <p><b>{NO_BAA_TITLE}</b> {NO_BAA_TEXT}</p>
            <p>What would have to be true first:</p>
            <ul className="pub-list">{NO_BAA_FIRST.map((x) => <li key={x}>{x}</li>)}</ul>
            <p>{NO_BAA_AFTER}</p>
            <p className="muted small">Nobody here is a lawyer and this is not legal advice. It is a statement of what Sign&Grow does not have. <Link href="/security#not">The other limits are on Security and trust</Link>.</p>
          </QA>

          <QA id="payment-link" q="Can someone pay a deposit when they sign?">
            <p>Sign&Grow does not take payments. What it can do is show a link to your own payment page, such as one from your card provider, right after a person presses Finish. {PAY_FOR_SENDER}</p>
            <p>{payNotYet(PAID_TRUST_DAYS)} Once it is offered, it is on the last step of the editor, next to the Send button, and a template&apos;s link goes with every envelope made from it.</p>
            <p>If you signed something and were shown a Pay button: your signature is complete whether you pay or not. The page names the sender and the full address the button opens. Sign&Grow cannot confirm or refund a payment, so ask the sender about it, and if you did not expect to pay anything, do not pay and report the request from the signing page.</p>
          </QA>

          <QA id="signing-groups" q="Can I send to a team, where anyone in it can sign?">
            <p>Yes, with a signing group, such as &ldquo;HR team&rdquo;. Admins make them under Contacts, with {GROUP_MIN_MEMBERS} to {GROUP_MAX_MEMBERS} people each, and everyone on the team can choose one as a recipient, also in templates. {GROUP_RULE}</p>
            <p>Each member has a link of their own. Once someone has taken it on, the others see who has it, and only you can give it back to the whole group: on the envelope page, choose <b>Give back to the group</b>. To change who is in the group on an envelope that is already out, choose <b>Edit envelope</b>. Changing the group under Contacts only changes what you send from then on. A one-time code by email or text message goes to one person, so it cannot be asked of a group. Public forms cannot send to a group.</p>
          </QA>
          <QA id="template-access" q="Who can use and change a template, and what does a locked wording mean?">
            <p>Each template has three settings, under <b>Who can use this</b> on the Templates page and in the template editor. <b>Who can use it</b>: everyone on the team (the usual), admins only, or members you choose. Nobody else sees it in their list. <b>Who can change it</b>: the person it belongs to and admins (the usual), members you choose as well, or everyone on the team. <b>Lock the wording</b>: someone who may not change the template can still fill in names, email addresses and the fields left empty for them, but not the documents, the fixed wording, the fields, the message or who signs in what order. The editor shows those parts as locked from the start, so nobody types and is turned down at the end.</p>
            <p>Only the person a template belongs to and admins can change these settings or delete the template, and every change is written to the template&apos;s history. The owner and admins of the account can always use and change every template. A copy of a template keeps who can use it, and a copy of a locked one stays with its owner, so a copy is no way round the lock. Locking holds for envelopes started from then on; unlocking frees the ones already started. When someone leaves the team or is removed, they are taken off every list of chosen members, and their templates pass to the person who takes over their work.</p>
            <p>A locked wording keeps your team from sending an altered contract from the template. It does not stop anyone from uploading a different document of their own, and it does not make a document right for what you use it for: the rules differ by country and by kind of document, so check what yours needs.</p>
          </QA>

          <QA id="cannot-send" q="Why can I not send?">
            <ul className="pub-list">
              <li><b>Your email address is not confirmed yet.</b> We sent a link when you signed up. The banner at the top of the app sends it again.</li>
              <li><b>The account has reached its daily limit.</b> An account that has not paid for anything can send to {abuse.firstWeekDaily} people a day in its first week and to {abuse.unpaidDaily} a day after that. Everyone you newly email counts, also people added or changed on a document that is already out and every row of a bulk send. A public form has the same limit of its own for the people who start it, counted for that form alone, and a team can invite {abuse.invitesPerDay} people a day. The limit looks at the last 24 hours, and the message says when there is room again. Paying does not lift it at once: it goes when a payment is {abuse.paidTrustDays} days old and was not refunded or disputed, and the message then gives the date. A person can lift it sooner: <a href="#contact" data-topic="sending">write to us</a>.</li>
              <li><b>The document reads like a payment notice from a well-known brand with a phone number to call, or the name you send under reads like such a brand.</b> That is how scams look, so an account cannot send those, or invite under such a name, until it has a payment that is {abuse.paidTrustDays} days old and was not refunded or disputed. We read what the emails print: the subject, the message, notes to recipients, document names, what you wrote on the pages, the reason for voiding, your name and the account name, and the name of a public form, which its page shows to anyone with the link. The message says which words set it off, so you can see whether it is a misreading. If yours is genuine, <a href="#contact" data-topic="sending">write to us</a> and a person will clear your account.</li>
              <li><b>Sending is paused.</b> This happens when {abuse.reportsToPause} different recipients report documents from one account, or when our team pauses it. The message and the banner in the app give the reason. A person reviews every pause. Until then nothing you start is emailed to anyone: no new documents, no new or changed recipients, no reminders, no reopening, no team invitations and no email about a change you make, and people who are waiting further down a signing order are asked only once the pause is lifted. You can still open, download and export everything, give a document that is out more time, and void one (the people on it are told, without your reason). People who already have a document can still sign it. If it is a mistake, <a href="#contact" data-topic="sending">write to us</a>.</li>
              <li><b>An access code is too short.</b> A code you set needs at least {abuse.codeMin} characters.</li>
              {textsOn && <li><b>A mobile number is missing or not complete.</b> Someone you check by text message, or text the link to, needs a number with its country code, like +44 7700 900123. Or the account has sent its {smsDaily} text messages for the day: the message says when there is room again, and a code by email always works. See <a href="#checking-signers">checking who signs</a>.</li>}
              <li><b>You are out of signatures.</b> See <a href="#signatures">how signatures work</a>.</li>
            </ul>
          </QA>

          <QA id="locked-out" q="I cannot log in">
            <p><b>Forgot the password?</b> <Link href="/forgot">Reset it here</Link>. The link we email works for one hour.</p>
            {signInWith && <p><b>Made your login with {signInWith}?</b> Use that button on the <Link href="/login">sign-in page</Link>. Such a login has no password until you choose one: <Link href="/forgot">the same link by email</Link> lets you do that, and under Settings, Profile you see every way into your login and can connect or disconnect {signInWith}. The last way in cannot be removed.</p>}
            {signInWith && <p><b>Told that you already have a login with this address?</b> Then {signInWith} did not confirm to us that the address is yours, and we never open an existing login on the strength of an address alone. Sign in with your password once (or choose one with the link by email), then connect it under Settings, Profile.</p>}
            <p><b>Lost the phone with your authenticator app?</b> Type one of your recovery codes in place of the code. Each works once. Without them:</p>
            <ul>{TWO_STEP_LOST.map((l) => <li key={l}>{l}</li>)}</ul>
            <p>After {TWO_STEP_TRIES} wrong codes in a row, wait {TWO_STEP_PAUSE_MINUTES} minutes before the next one, and check that the time on your phone is set automatically: the codes depend on it.</p>
            <p><b>No longer have that mailbox?</b> You can still <a href="#stop-by-card">stop the billing with your card</a>. Then <a href="#contact" data-topic="cannot-log-in">write to us</a> and a person will help with the account.</p>
            <p><b>On a team?</b> An owner or admin can remove someone who has left. What that person sent (envelopes, drafts, templates and bulk sends) passes to a member the admin chooses, and each envelope&apos;s audit trail says so. The owner can hand the whole account to someone else under Settings, then Team.</p>
            <p><b>Were you removed from a team?</b> Your login still works. Sign in and you get an empty workspace of your own, with your inbox of documents sent to you. A team can invite you again at any time: sign in from the invitation and you are on it.</p>
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
          <QA id="after-writing" q="What happens after I write?">
            <ul className="pub-list">
              {support.promised && <li><b>{replyPromise(support.hours, support.urgentHours)}</b> The confirmation email and the request itself give the exact time, in your own time zone where your browser tells us it.</li>}
              {support.promised && <li><b>If we are late, we say so.</b> The request says it in plain words, everyone who answers is emailed, and so are you. You do not have to ask twice.</li>}
              <li><b>One person has it.</b> When someone on our team takes your request, it shows their first name.</li>
              <li><b>Every answer is emailed to you in full.</b> You never have to sign in to read one.</li>
              <li><b>Each email has a private link to your request.</b> It works without signing in. There you read everything written so far, reply, and mark it as solved. Whoever has the link can do that, so keep those emails to yourself. Replying to the email itself does not reach your request: use the link.</li>
              <li><b>A request is never closed on you without a written answer.</b> If it was closed and is not solved, reply within {support.reopenDays} days and the same request opens again. After that, a reply starts a new request that is linked to the old one. The one exception is a message that does not look like it came from the owner of the address, such as an advert typed into the form: the address then gets a short note that says so and how to open it again.</li>
            </ul>
            {support.promised && <ReplyRecord />}
          </QA>
          <div style={{ marginTop: 12 }}><ContactForm /></div>
          <QA id="lost-link" q="I wrote to you and cannot find the email with the link">
            <p>Enter the address you wrote from. We send the link to each of your requests again, to that inbox only. The links are the same as before, so an older email still works too.</p>
            <FindRequests />
          </QA>
          <YourRequests />
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
