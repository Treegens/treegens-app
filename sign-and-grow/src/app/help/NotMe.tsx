import Link from 'next/link';

// "I am named on a document I did not sign": what we give out about a document and to whom, exactly as the code does
// it (the lookup by ID and the file check in src/server/evidence.ts and routes-account.ts, /check in routes-trust.ts,
// the envelope page for its sender), and what such a person can do. The help topic 'not-me' is never passed on to
// the document's sender (POST /public/support in routes-support.ts passes on 'signing' only).
export function NotMeAnswer() {
  return (
    <>
      <p>We cannot tell who really signed. We can tell you what we hold, mark the document as disputed, and say exactly who gets to see what.</p>
      <p><b>Mark it as disputed.</b> Open the document and choose <b>Report this request</b>, then <b>I did not sign this, or this was not me</b>. Or, without opening anything, type the security code from our email into <Link href="/check">Check an email</Link> and choose the same. It works for a completed document too. From then on the document shows as disputed, to its sender and to anyone who checks it on <Link href="/verify">Verify a document</Link>. The sender and the people who run Sign&amp;Grow are told. Nothing is changed or deleted because of it.</p>
      <p><b>Keep your own copy.</b> Download the PDF from your link while you can. Its certificate lists what was recorded, and <Link href="/security/certificate">How to read a Sign&amp;Grow certificate</Link> explains each line. A dispute does not stop the sender from closing their account later; after that we keep only the fingerprint of the signed file, for one year.</p>
      <p><b>What we give out, and to whom:</b></p>
      <ul className="pub-list">
        <li><b>Anyone with the envelope ID</b> printed at the foot of every page: whether it was completed, voided, declined or ran out of time and when, how many pages it has, how many people were asked to sign and how many did, the fingerprint of the signed file, and whether someone disputes it. Never a name, an address or the title.</li>
        <li><b>Anyone with the signed file itself</b>, on Verify a document: its title, the sender&apos;s name, the names of the people on it with their email addresses shortened, when each finished, and whether the record is intact. The certificate inside the file already holds more than that.</li>
        <li><b>Anyone holding an email we sent about it</b>, or its link: who sent it and what it is called, and with the link the document itself, and once it is completed the signed PDF with its certificate: every name, email address, internet address and the whole audit trail. Find my documents sends those links again, but only ever to the address the document was sent to. If that address was never yours, we cannot send it to you.</li>
        <li><b>The sender, and the owner and admins of the sender&apos;s account:</b> everything about the document, including its audit trail and, if you dispute it, that you did and when. Not what you write to us under this topic, and not what you write with a dispute.</li>
        <li><b>The people who run Sign&amp;Grow:</b> what they need to look into it.</li>
      </ul>
      <p>If a court or the police asks us for records, a person handles that request. There is no written procedure for it yet, so we promise nothing more here than that.</p>
      <p><b>If it is a legal matter</b>, the rules differ by country and by kind of document. Ask a lawyer, or the police if you think a crime was committed.</p>
      <p><a href="#contact" data-topic="not-me" className="btn sm">Write to a person about it</a> <span className="muted small">What you write under this topic goes to the people who run Sign&amp;Grow only. It is not passed on to the sender.</span></p>
    </>
  );
}
