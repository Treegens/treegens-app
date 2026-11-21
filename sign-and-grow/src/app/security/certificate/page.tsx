import type { ReactNode } from 'react';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { PrintButton } from '../processing/PrintButton';
import { CHAIN_TRUTH, WHO_WHEN_WHERE, CERTIFICATE_PAGE_VERSION } from '@/lib/evidence';
import { sealSet, SEAL_TRUTH, SEAL_TIME, SEAL_TRUST, SEAL_LIMITS } from '@/lib/seal';

export const metadata = { title: 'How to read a GrowSigning certificate', description: 'Every line of a GrowSigning certificate of completion: where the software takes it from, what it shows and what it does not. Dated, for a lawyer to attach.' };

// Read on every request, because the Digital seal part is only there on a server with a seal key (sealSet).
export const dynamic = 'force-dynamic';

// Written from drawCertificate() and renderEnvelopePdf() in src/server/pdf.ts as they are on CERTIFICATE_PAGE_VERSION,
// and from where each value is set (src/server/envelopes.ts, src/lib/checks.ts). When the certificate changes, this page
// and the date change with it. Each line says where it comes from, what it shows and what it does not, and nothing more.

function Line({ label, from, shows, not }: { label: string; from: ReactNode; shows: ReactNode; not?: ReactNode }) {
  return (
    <div className="pub-cert-line">
      <h3>{label}</h3>
      <p><b>Comes from:</b> {from}</p>
      <p><b>Shows:</b> {shows}</p>
      {not && <p><b>Does not show:</b> {not}</p>}
    </div>
  );
}

export default function HowToReadACertificate() {
  return (
    <div className="pub pub-print">
      <PublicNav />
      <main id="main" className="wrap pub-page pub-doc">
        <header className="pub-top">
          <h1 className="pub-h1">How to read a GrowSigning certificate</h1>
          <p className="pub-lead">Every line of the certificate of completion at the end of a signed PDF: where the software takes it from, what it shows, and what it does not.</p>
          <p className="pub-doc-meta">Version of this page: {CERTIFICATE_PAGE_VERSION}. It describes certificates as GrowSigning prints them on that day. If yours has lines that are not here, it was made by another version: <Link href="/help#contact">ask us</Link> which.</p>
          <div className="pub-doc-actions">
            <PrintButton />
            <span className="muted small">Your browser&apos;s print window has &quot;Save as PDF&quot;. On a phone, choose Share, then Print.</span>
          </div>
        </header>

        <h2>What this page is</h2>
        <p>A description of what the software records and prints, written from its code. It is not a statement about any one document, not a sworn statement, and not legal advice. Whether an electronic signature is accepted, and what it proves, depends on the country and on the kind of document: ask a lawyer where you are.</p>
        <p>Three things to keep in mind throughout. {WHO_WHEN_WHERE} And the certificate is made once, the moment the last person finishes. What happens after that (the completed copy being emailed, its first download by each person, later visits, a dispute) is only in the envelope&apos;s live audit trail: on the sender&apos;s envelope page, in the sender&apos;s evidence pack, and in part through a lookup by envelope ID on <Link href="/verify">Verify a document</Link>.</p>

        <h2>Envelope</h2>
        <Line label="Envelope ID" from="A random reference given to the envelope when it was created. The same ID is printed at the foot of every page of the documents and of the certificate." shows={<>Which envelope in our records the pages belong to. Anyone can look it up on <Link href="/verify">Verify a document</Link> to see whether it was completed, when, how many pages and signers it has, the fingerprint of the signed file, and whether someone disputes it.</>} not="It is not a secret and not a seal: anyone can type an ID onto a page. Compare the file itself, or its pages, with what the lookup says." />
        <Line label="Subject" from="What the sender typed." shows="What the sender called the envelope." not="Anything about what the documents say." />
        <Line label="Status" from="The state of the envelope when the signed PDF was made. A certificate is only ever made for a completed envelope, so it says Completed." shows="That everyone asked to sign, approve or view had finished." not="Anything that happened later, such as a dispute. The lookup by envelope ID shows that." />
        <Line label="Sender" from="The name and email address of the login holding the envelope when it was completed, as they were then. That is the login that sent it, unless that person left the team or closed their login while it was out: then what they sent passes to the owner of the account, the audit trail says so in a line &ldquo;Handed over&rdquo;, and the new holder is printed here. The address was confirmed by a link sent to it before the account could send anything." shows="Which login held the envelope when it was completed, and that its holder could read that mailbox when it was confirmed." not="That the name is the person's real name: it is what they typed when they signed up. Nor, after a hand-over, who sent it first: the audit trail says that." />
        <Line label="Sent" from="The moment the sender sent the envelope, in UTC." shows="When the envelope went out." not="When each person's email left; see Sent under each recipient." />
        <Line label="Completed" from="The moment the last person finished, in UTC. The signed PDF and its fingerprint are made right after." shows="When everyone had finished." />
        <Line label="Signing order" from="What the sender chose: Sequential (one after another, in the order shown) or Everyone at once." shows="Whether people were asked in turn." />

        <h2>Documents</h2>
        <Line label="Name and number of pages" from="The file name as uploaded (the sender can rename it) and the page count read from the file." shows="Which files make up the envelope." />
        <Line label="SHA-256 of the original" from="The fingerprint of each file as the sender uploaded it, before anything was stamped on it." shows="Whether a file you hold is that exact upload: its SHA-256 must be the same." not={<>The fingerprint of the signed PDF itself, which cannot be printed inside the file it describes. That one is in every completion email, and <Link href="/verify">Verify a document</Link> checks a file against it.</>} />

        <h2>Recipients</h2>
        <p>One block for each person on the envelope, in the signing order.</p>
        <Line label="Name (and, for a group, the member who acted for it)" from="What the sender typed, or the name as corrected later. A signer can fix the spelling of their own name, and the sender can correct a name; the audit trail says when and by whom." shows="Who the sender meant this place on the document for." not="Who actually used the link. Whoever held the link could act under this name, and the sender can open a link too." />
        <Line label="Role" from="What the sender chose: Signer, Approver, Receives a copy, Needs to view, In-person signer (signed on the sender's device), or Witness (watched one signer sign, and is listed straight after them)." shows="What this person was asked to do." />
        <Line label="Status" from="What this person did: Signed, Approved, Viewed, Copied or Witnessed." shows="That their part was finished." />
        <Line label="Witnessed by, Witness for, Their statement, Statement ticked, Marked, Same device, Note" from="For a signer with a witness: who witnessed them. For the witness: whose signature, the statement they ticked and when, what about the witnessing is marked because a challenge would look at it (for example that the witness is a party), whether the witness used the same device as the signer (yes or no only), and a note on what a witness line does and does not show." shows="That a second person said they watched this signature being made, in their own words as ticked." not="That the witness was really there, or who they are: they are a name and an address like anyone else on the envelope. Whether a witness is needed, and who may be one, depends on the country and the kind of document." />
        <Line label="Sent" from="The moment this person's turn started and our email to them was written, in UTC." shows="When they were asked." not={<>That an email left or arrived. The audit trail says &ldquo;Sent to recipient&rdquo; only when the mail server took the email, and &ldquo;Not emailed&rdquo; when none went out, for example for someone who signed in person or whose link the sender passed on.</>} />
        <Line label="Viewed" from="The first time this person's link opened the document, in UTC." shows="That the link was opened then." not="Who opened it, or later visits. Later visits are in the live audit trail, at most one line a day for each person." />
        <Line label="Completed, First completed, Completed again" from="The moment this person pressed Finish (also to approve or confirm). When someone finished, the sender then changed the document, and they finished again, both moments are printed." shows="When their part was done, and that they did it again after a change. The audit trail says what changed." />
        <Line label="Identity check" from="The check the sender asked for before the document opened, and whether it was passed. The words are, for example: Link sent by email only; Link sent by email and an access code chosen by the sender; Link shared by the sender only; Signed in person on a device of the sender; or a one-time code by email or text message, passed at a time, with the masked address or number it went to." shows="What had to be got past before the document opened." not={<>Who the person is. Nothing here looks at an identity document. An access code is chosen by the sender, who can read it. Today &ldquo;Link sent by email&rdquo; is also printed for someone the audit trail lists as &ldquo;Not emailed&rdquo;: in that case the trail is right, and the link reached them some other way.</>} />
        <Line label="E-record consent" from="The moment this person ticked that they agree to use electronic records and signatures, in UTC. Their audit line names the version of the wording their screen showed." shows={<>That this step was taken from their link. The wording of each version is on the <Link href="/help">help page</Link>, under &ldquo;What do I agree to before I sign?&rdquo;.</>} />
        <Line label="IP address" from="The internet address of the request that finished their part, or of the first time their link opened if they have not finished." shows="Which internet connection the request came through." not="A place or a person. Many people can share one connection, and it can be the sender's own." />
        <Line label="Time zone, and the times in their own zone" from="What the person's device reported. The date of signing on the pages is the calendar day in that zone." shows="Which day the date printed on the pages rests on." not="Where the person was. A device can be set to any zone." />
        <Line label="Reassigned from" from="The person who passed the document on to this one." shows="That someone else was asked first and handed it over." />
        <Line label="Signature picture" from="The picture this person adopted: their name typed in a handwriting style, drawn with a finger or mouse, or a picture they uploaded." shows="The mark that was put on the pages." not="How it was made: the certificate does not say whether it was typed, drawn or uploaded, and the audit trail does not either." />
        <Line label="Sent to, or Acted for (a group)" from="The members of a group the document was sent to, as it was sent." shows="Everyone who could have acted for the group, and who did." />

        <h2>Audit trail</h2>
        <Line label="The sentence under the heading" from="Printed on every certificate. It says the history cannot be edited without breaking the chain." shows={CHAIN_TRUTH} not="That nobody could rewrite the record. It shows that the stored lines were not edited without recomputing them, and the chain head below lets a copy someone already holds expose a rewrite." />
        <Line label="Each line" from="One line for each thing that happened before the certificate was made: the time in UTC; what happened, with its details; who (the name and address the line is signed with, or System for what the software did by itself); the internet address; the first 16 characters of the line's fingerprint; and, for someone whose device reported a time zone, their own time." shows="The record of the envelope up to completion, in order." not="Anything after completion, and anything listed as not recorded on the security page: whether an email was opened in the mailbox, how long a page was looked at, more than one later visit a day, how a signature was made." />
        <Line label="Chain head" from="The full fingerprint of the last line when the certificate was made." shows="The value the stored audit trail must still lead to. A sender's evidence pack lists every line with its fingerprint, so the two can be compared line by line." not="Anything written after completion: the completed copy being emailed and opened, later visits, disputes and their closing. Those lines come after the head, so a rewrite of them would not show against anyone's copy." />
        <Line label="Characters this PDF could not print" from="Characters typed somewhere on the envelope for which the PDF has no font, listed by their Unicode number." shows="What was typed where the pages show a mark instead." />
        <Line label="Signed without paper" from="An estimate of the paper, water and CO2e not used, worked out from the number of pages." shows="An environmental estimate." not="Anything about the signatures." />

        {/* The line drawCertificate prints from sealLineFor (src/server/seal.ts, words in src/lib/seal.ts). Only on a
            server whose operator has set a seal key: without one no certificate has the line, and nothing here speaks of it. */}
        {sealSet() && <>
          <h2 id="seal">Digital seal</h2>
          <Line label="Digital seal" from="Printed only on the certificate of a signed PDF that carries the seal: the name on the certificate the seal was made with, who issued that certificate, and where the time in the seal comes from (this server's clock, or a time stamp from a time-stamp service, and whether that service's certificate was checked). The seal is added to the file right after the certificate is drawn, as an invisible signature over every byte of it. A certificate handed out on its own, as certificate.pdf in an evidence pack, is cut out of the signed PDF and carries no seal itself: the line speaks of the signed PDF." shows={<>{SEAL_TRUTH} {SEAL_TIME}</>} not={<>Who stood behind each signature, or that a signature is valid in law. {SEAL_TRUST} {SEAL_LIMITS}</>} />
        </>}

        <h2>On the pages of the documents</h2>
        <Line label="GrowSigning Envelope ID at the foot of every page" from="The envelope ID above." shows="Which envelope the page belongs to, also on a printed copy." not="That the page was not swapped or changed: compare it with the signed file." />
        <Line label="Signed via GrowSigning, with eight characters, under a signature" from="The last eight characters of the internal reference of the person on the envelope the signature belongs to." shows="That the signature was placed by the software." not="Who it belongs to, to a reader: the certificate does not print that reference, so only we can match it, from our records, while we hold them." />
        <Line label="NOT COMPLETED BY EVERYONE, and VOIDED, DECLINED or EXPIRED across the page" from="Printed on every copy made after an envelope was voided, declined or ran out of time, which opens with a page that says why. A copy made while it was still out says NOT COMPLETED YET instead, in the same way, because voiding it later cannot change a file already downloaded. The words are large across the middle, again in small dark rows over the whole page, corners included, at the top and the bottom, and over every signature, initials and stamp, so they stay on a page that is cut up or copied in black and white." shows="That it is not a signed document, whatever signatures are on it. Such a copy has no certificate." not={<>That a copy without them is signed: someone with a PDF editor can remove drawn marks. Look the envelope ID up on <Link href="/verify">Verify a document</Link>: it says whether the envelope was ever completed.</>} />

        <h2>Checking a certificate</h2>
        <ul className="pub-list">
          <li>The file: choose it on <Link href="/verify">Verify a document</Link>. A match means it is byte for byte the file stored when everyone finished.</li>
          {sealSet() && <li>The digital seal, when the certificate has a Digital seal line: open the signed PDF in a PDF reader that checks signatures, such as Acrobat, and look at its signature panel. It says whether the file changed after it was sealed. <Link href="/verify">Verify a document</Link> checks the seal as well.</li>}
          <li>A printed or scanned copy: look up its envelope ID on the same page and compare the pages, the number of pages and the fingerprint.</li>
          <li>The record after completion: the sender can download the evidence pack from the envelope page. Anyone named on the document can mark it as disputed: see <Link href="/help#not-me">I am named on a document I did not sign</Link>.</li>
        </ul>
      </main>
      <PublicFooter />
    </div>
  );
}
