import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { dataPlace, notSaid } from '@/lib/dataplace';
import { CLOSE_GRACE_DAYS, CLOSING_REMINDER_DAYS, MAIL_COPY_DAYS, DELETED_WITH_ACCOUNT, KEPT_AFTER_DELETION, powerformIdleHours } from '@/lib/policy';
import { mailEventsOn, BOUNCE_WARN_DAYS } from '@/lib/policy';
import { ProcessorTable, Stated } from '../DataPlace';
import { PrintButton } from './PrintButton';
import { CHAT_KEPT_PAGE } from '@/lib/chat';
import { CHAT_NOT_TRAINED, chatTermsLine, modelLine } from '@/lib/chatboundary';
import { chatProvider } from '@/lib/chatprovider';
import { readPossible, READ_SENT, READ_KEPT, READ_ALSO } from '@/lib/aiassist';
import { dayText } from '@/lib/dates';
import { fileEncryptionOn, PROCESSING_ENCRYPTED, databaseText, processingNotDone } from '@/lib/storedfiles';
import { PURGE_LEVELS, LEVEL_NAME, LEVEL_REMOVES, retentionStays, HOLD_TRUTH, HOLD_BACKUPS, HOLD_OVERRIDE, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS, RETENTION_NOTICE_DAYS } from '@/lib/retention';

export const metadata = { title: 'Data processing summary', description: 'What this GrowSigning server processes, for whom, for how long, where, and how it is deleted. One page you can save as a PDF.' };
// Where the data is and who handles it are settings. Read them when the page is asked for, not when the site is built.
export const dynamic = 'force-dynamic';

// A plain summary for a customer who has to show someone where their documents are and what happens to them.
// Every fact on it comes from somewhere the server itself reads: the settings (src/lib/dataplace.ts) and the rules
// in src/lib/policy.ts, which the deleting code is held to. Before adding a sentence, find the code that makes it
// true. This is a description, not a contract, and the page says so first.

export default function ProcessingSummary() {
  const d = dataPlace();
  const chatAt = chatProvider();
  const today = dayText(new Date());
  return (
    <div className="pub pub-print">
      <PublicNav />
      <main id="main" className="wrap pub-page pub-doc">
        <header className="pub-top">
          <h1 className="pub-h1">Data processing summary</h1>
          <p className="pub-lead">What this server processes, for whom, for how long, where, and how it is deleted.</p>
          <p className="pub-doc-meta">Made on {today} from the settings and rules this server runs on. Server operated by: <Stated value={d.operator} what="who they are" /></p>
          <div className="pub-doc-actions">
            <PrintButton />
            <span className="muted small">Your browser&apos;s print window has &quot;Save as PDF&quot;. On a phone, choose Share, then Print.</span>
          </div>
        </header>

        <h2>What this page is, and what it is not</h2>
        <p>It describes what the software does with personal data. It is not a contract and not legal advice. If you need a signed data processing agreement, for example because the GDPR applies to you, that agreement is between you and whoever runs this server{d.operator ? <> ({d.operator})</> : null}. The software cannot sign one for them, and no standard contract comes with it. {!d.operator && notSaid('who they are')} Reach them through <Link href="/help#contact">the contact form</Link>.</p>

        <h2>Who decides, and who handles</h2>
        <ul className="pub-list">
          <li><b>You, the account holder,</b> decide which documents are uploaded, who they are sent to and how long they are kept.</li>
          <li><b>The operator of this server</b> stores and handles them for you with this software. The software does not read documents to sell anything, does not pass them to an AI service and does not use them to train one{d.processors.some((p) => p.id === 'chat') ? ' (the exceptions are below: a text someone writes in the app and asks the AI to draft or change, and, on accounts whose admin switched on &ldquo;Let the AI read document text&rdquo;, the text used for AI help when sending and signing)' : ''}. What the operator does beyond the software is for them to say.</li>
          <li><b>The people you send to</b> get what you send them, and keep their own copy of what they signed.</li>
        </ul>

        <h2>What is processed</h2>
        <ul className="pub-list">
          <li><b>About account holders:</b> name, email address, a salted hash of the password (never the password), a job title and company if given, a saved signature and initials if saved, team memberships, notification settings, and the time zone their browser reports, which decides the day written for their signers when a signer&apos;s own device says none.</li>
          <li><b>Documents:</b> the files you upload, the text read from PDFs so that you can search your own envelopes, the fields placed on them, the signed PDFs with their certificates, and files that signers attach.</li>
          <li><b>About the people you send to:</b> the name and email address you typed, an access code or a mobile number if you set one, what they filled in, their signature and initials as pictures, when they opened, agreed, signed or declined, and the time zone their device reports, which decides the date printed for them and is on the certificate.</li>
          <li><b>The audit trail of every envelope:</b> each step with its time, the internet address it came from and the kind of browser.</li>
          <li><b>Emails:</b> a copy of every email this server sends, and whether the mail server took it.{mailEventsOn() && ' Afterwards, what the mail provider tells us about it: that it reached the recipient\'s mail server, came back, or was marked as spam, with the reason the mail server gave. That reason is seen only by the people who run this service; senders are told what it means in our own words.'}</li>
          <li><b>Payments, if you pay:</b> what was paid, refunded and bought, and the provider&apos;s reference for it. A full card number never reaches this server.</li>
          <li><b>Help requests:</b> what was written, by whom, and the answers.</li>
          <li><b>The help chat:</b> {CHAT_KEPT_PAGE}{chatAt && d.processors.some((p) => p.id === 'chat') ? ` What is typed into it goes to the help chat provider in the table below, to be answered. ${modelLine(chatAt)} ${chatAt.inside ? CHAT_NOT_TRAINED : chatTermsLine(chatAt.name, chatAt.style === 'plain')}` : ' On this server it answers from the built-in help, so nothing typed into it leaves the server.'}</li>
          {/* Writing a document in the app (src/server/writedoc.ts) uses the same model and settings as the help chat. */}
          {/* AI help when sending and signing (src/server/aiassist.ts), with the same model and settings. */}
          {d.processors.some((p) => p.id === 'chat') && readPossible() && <li><b>AI help when sending and signing:</b> {READ_SENT} {READ_KEPT}</li>}
          {d.processors.some((p) => p.id === 'chat') && <li><b>Writing a document in the app:</b> on accounts whose AI switch is on, when someone presses &ldquo;Write it&rdquo; or &ldquo;Ask for a change&rdquo;, what they typed in that writing view (their description, the text and the change they ask for) goes to the same provider as the help chat, to write it. Never other documents, contacts or anything from other envelopes, and nothing that says who is asking. Nothing of it is kept beyond the text the person chooses to make into a document, which is kept with that document.</li>}
        </ul>

        <h2>For how long</h2>
        <ul className="pub-list">
          <li><b>As long as the account exists.</b> Cancelling a plan or a failed payment deletes nothing.</li>
          <li><b>A draft, a template, or a closed envelope that nobody signed</b> is deleted for good when you delete it.</li>
          <li><b>An envelope that somebody signed</b> cannot be erased by itself. Deleting it takes it out of your lists, search and export, and its recipients keep their link and their copy until its files are deleted. That happens when the account is deleted, or earlier by the account&apos;s deletion schedule or at the request of its sender or an admin (below). The recipients are not told.</li>
          {/* The account's retention rule and legal holds (src/server/records.ts, the words in src/lib/retention.ts). */}
          <li><b>A finished document, under the account&apos;s deletion schedule</b> (off unless an admin switches it on, under Settings, Records and data, Keep and delete): an admin sets after how many days completed documents are deleted, and after how many days cancelled, declined and expired ones are, each from {RETENTION_MIN_DAYS} to {RETENTION_MAX_DAYS.toLocaleString('en-US')} days, counted from the day the document ended, or a template&apos;s own period. The sender and the admins get an email at least {RETENTION_NOTICE_DAYS} days before (at most one a week for an account), and can keep any of them. The sender or an admin can also ask to delete the files of one finished document; that waits {RETENTION_NOTICE_DAYS} days and can be called off until then. While a hold is on, the software refuses to delete what it covers.</li>
          <li><b>Our copies of emails that belong to no document</b> (invitations, notices, receipts) are deleted after {MAIL_COPY_DAYS} days. Copies of emails about a document stay with that document.</li>
          {mailEventsOn() && <li><b>An address at which an email came back for good</b> stays on its account&apos;s list for {BOUNCE_WARN_DAYS} days, so that a new envelope to it warns the sender first. To count &quot;try later&quot; answers on separate days, only a keyed fingerprint of the address is kept, for the same {BOUNCE_WARN_DAYS} days. When an envelope is deleted, the number of each of its emails, the account that sent it and a keyed fingerprint of the address (not the address) are kept for {BOUNCE_WARN_DAYS} days, so a spam complaint about it still counts against that account.</li>}
          {mailEventsOn() && <li><b>An address that marked an email from an account as spam</b> stays on that account&apos;s list, so the account does not email it again, until the person asks for our emails again on a signing page or the account is deleted.</li>}
          <li><b>An unfinished start from a public form</b> is closed after {powerformIdleHours()} hours without anyone touching it.</li>
          <li><b>A file dropped on <Link href="/verify">Verify a document</Link></b> is not stored.</li>
          <li><b>A closed account</b> is kept for {CLOSE_GRACE_DAYS} days so that it can be brought back, with an email to its owner {CLOSING_REMINDER_DAYS} days before the end, and is then deleted. You can also delete it at once.</li>
          <li><b>Backups:</b> <Stated value={d.backups} what="whether and where backups are kept" /></li>
        </ul>

        <h2>How it is deleted</h2>
        <p>Under Settings, Records and data, <b>Close my account</b>, at once or after the {CLOSE_GRACE_DAYS} days. This goes for good:</p>
        <ul className="pub-list">{DELETED_WITH_ACCOUNT.map((x) => <li key={x}>{x}</li>)}</ul>
        <p>This stays, and why:</p>
        <ul className="pub-list">{KEPT_AFTER_DELETION.map((x) => <li key={x}>{x}</li>)}</ul>

        <h2 id="deleted">Deleting the files of a finished document</h2>
        <p>The admin, or whoever asks for one document, chooses what is deleted. Each choice deletes what the one before it does, and more (the one in the middle is only offered through the API):</p>
        <ul className="pub-list">{PURGE_LEVELS.map((l) => <li key={l}><b>{LEVEL_NAME[l]}.</b> {LEVEL_REMOVES[l].join(' ')}</li>)}</ul>
        <p>What stays:</p>
        <ul className="pub-list">{retentionStays(d.backups).map((x) => <li key={x}>{x}</li>)}</ul>
        <p>{HOLD_TRUTH} {HOLD_BACKUPS} {HOLD_OVERRIDE}</p>

        <h2>Where it is, and who else handles it</h2>
        <ul className="pub-list">
          <li><b>The server and its files:</b> <Stated value={d.region} what="where it is hosted" /> {d.host ? <>Hosted by {d.host}.</> : notSaid('which company hosts it')} There is one region, and it cannot be chosen.</li>
          <li><b>What leaves the server:</b> only what the table lists. There is no analytics service and no advertising{d.processors.some((p) => p.id === 'chat') ? '. The one AI service is the help chat\'s, and it gets only what people type into the chat, and what they type in the writing view when they ask it to write' + (readPossible() ? `${READ_ALSO}.` : '.') : ', and no AI service.'}</li>
        </ul>
        <ProcessorTable d={d} />
        {d.off.length > 0 && <p style={{ marginTop: 12 }}><b>Not in use on this server:</b> {d.off.join(' ')}</p>}
        {d.unstated.length > 0 && (
          <>
            <p><b>Not stated by the operator of this server.</b> Ask them before you rely on this page for any of it:</p>
            <ul className="pub-list">{d.unstated.map((u) => <li key={u}>{u}</li>)}</ul>
          </>
        )}

        <h2>How it is protected</h2>
        <ul className="pub-list">
          <li>Passwords are kept as salted scrypt hashes. API keys and login sessions are kept as fingerprints, never as written.</li>
          <li>Only the people a document was sent to, its sender and the admins of the sender&apos;s account can open it. Sign-in attempts, access codes and the public forms are rate limited.</li>
          <li>The audit trail of every envelope is hash chained, so a changed or missing entry shows.</li>
          {/* Whether this server encrypts its stored files is a setting (FILE_ENCRYPTION_KEY, src/lib/storedfiles.ts). */}
          {fileEncryptionOn() && <li>{PROCESSING_ENCRYPTED}</li>}
          {/* What stays readable in the database either way, the same list as on /security. */}
          <li>{databaseText()}</li>
          <li><b>What the software does not do:</b> {processingNotDone()} It has no security certification. The <Link href="/security">security page</Link> lists the rest.</li>
        </ul>

        <h2>Taking your data with you</h2>
        <p>Settings, Records and data, <b>Export everything</b> (owners and admins): one ZIP file with every signed PDF and its full record for disputes, every document and the full history of each, templates, contacts, groups and settings, in an open, published format. Free on every plan, also after cancelling. Anyone can download the signed PDFs and a spreadsheet with <b>Download signed PDFs (ZIP)</b> on Documents.</p>

        <p className="muted small no-print" style={{ marginTop: 24 }}>Something on this page that is not true? <Link href="/help?topic=other#contact">Tell us</Link>. A person reads every message.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
