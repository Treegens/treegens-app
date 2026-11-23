import type { ReactNode } from 'react';
import Link from 'next/link';
import { consentWording, consentIsShort, CONSENT_HISTORY, CONSENT_PARTS, adoptLine, LANGUAGE_NOTE, cannotOpenLine, type ConsentPart } from '@/lib/policy';
import { ConsentDetailWords } from '@/components/sign/ConsentDetails';
import { versionText } from '@/lib/wordingday';
import { COUNTRY_NOTES, paperWordList } from '@/lib/paperwork';
import { BY_SENDER_TICK, BY_SENDER_HOW, BY_SENDER_LINE } from '@/lib/bysender';

// The answers on /help about what a signature made here is, and is not: what a signer agrees to, whether a simple
// electronic signature is enough, and which language people are asked in. Kept beside the help page, in a file of
// its own, because every sentence here is about law somewhere and has to stay careful. Nobody who wrote this is a
// lawyer. The page says what the software does and does not do, that rules differ by country and by kind of
// document, and tells people to check. It never promises what a court or a registry will make of a signature.

const QA = ({ id, q, children }: { id: string; q: string; children: ReactNode }) => (
  <article className="pub-qa" id={id}>
    <h3>{q}</h3>
    {children}
  </article>
);

/** One wording as its screen showed it: the paragraphs above the tick, or the one sentence with what its link opens. */
function WordingQuote({ version }: { version?: string }) {
  const w = consentWording('the sender', true, version);
  return (
    <blockquote className="pub-quote">
      {consentIsShort(w) ? (
        <>
          <p><b>{w.agree}</b></p>
          <p className="muted small">Under the link &quot;{w.more}&quot;, on the same screen:</p>
          <ConsentDetailWords wording={w} />
        </>
      ) : (
        <>
          <p>{w.legal}</p>
          <p>{w.practical}</p>
          <p><b>{w.agree}</b></p>
        </>
      )}
    </blockquote>
  );
}

// Who each other set of words is for, in the words of this page.
const PART_WORDS: Record<ConsentPart, string> = {
  signer: 'Someone who signs', inperson: 'Someone who signs in person, on the sender\'s device', witness: 'A witness', approver: 'Someone who approves',
  step: 'Someone who changes the document or chooses who comes next', reader: 'Someone who only reads',
};
/**
 * What the people who do not sign through their own link are shown instead: their sentence, and each line behind the
 * link that is not also the signer's. So every word a record can point to is printed here, not only the signer's.
 */
function OtherParts() {
  const mine = consentWording('the sender', 'signer');
  const said = new Set(mine.details.flatMap((d) => d.lines));
  return (
    <ul className="pub-parts">
      {CONSENT_PARTS.filter((p) => p !== 'signer').map((p) => {
        const w = consentWording('the sender', p);
        const own = w.details.flatMap((d) => d.lines.filter((l) => !said.has(l)));
        return <li key={p}><b>{PART_WORDS[p]}</b> ticks &quot;{w.agree}&quot;{own.length ? <> and reads these lines in place of the signer&apos;s: &quot;{own.join(' ')}&quot;</> : null}</li>;
      })}
    </ul>
  );
}

/** For people who sign: the exact words of the consent screen, with the version the audit trail names. */
export function ConsentWords() {
  const w = consentWording('the sender', true);
  const earlier = CONSENT_HISTORY.filter((h) => h.version !== w.version);
  return (
    <QA id="consent-wording" q="What do I agree to before I sign?">
      <p>You tick one box: &quot;{w.agree}&quot; The rest is behind the link &quot;{w.more}&quot; on the same screen, under Continue. Both are printed here in full.</p>
      <WordingQuote />
      <p className="muted small">The document&apos;s history records that you agreed, when, and which wording your screen showed. This is the wording of {versionText(w.version)}, the one in use now, as shown to someone who signs. Where it says &quot;the sender&quot;, your screen names the person. When you place your signature you also agree to this: &quot;{adoptLine('signature')}&quot;</p>
      <details className="pub-fold">
        <summary>What other people are shown: in person, witnesses, approvers and readers</summary>
        <p className="muted small">The same, with the lines about signing and about saying no changed to fit what each of them can do:</p>
        <OtherParts />
      </details>
      <p className="muted small">{LANGUAGE_NOTE} If you cannot read what you are asked to agree to, do not tick the box: ask the sender to explain it or to send the document on paper.</p>
      {/* A record names the wording its person was shown, and that may be an earlier one: each stays here to be read. */}
      <details className="pub-fold">
        <summary>Earlier wordings, for a record that names one</summary>
        <p className="muted small">A history line or a certificate says &quot;Wording of&quot; and a day. If yours names one of these days, this is what that screen showed. The earlier wordings printed everything above the box.</p>
        {earlier.map((h) => (
          <div key={h.version} id={`wording-${h.version}`}>
            <p><b>Wording of {versionText(h.version)}</b>, first shown on {h.from}.</p>
            <WordingQuote version={h.version} />
          </div>
        ))}
      </details>
    </QA>
  );
}

/** For people who send: what kind of signature this is, and the one sentence about language. */
export function SignatureKind() {
  return (
    <>
      <QA id="enough" q="Is this signature enough for my document?">
        <p>GrowSigning makes a <b>simple electronic signature</b>: the signer&apos;s name or mark on the page, and a record of who was sent the link, when they agreed and signed, and from which internet address. It does not check anyone&apos;s identity document, and it has no notary step. A witness can be added for a person who signs: they state that they saw the signature being made, and GrowSigning cannot check that they were there (<a href="#witness">how a witness works</a>).</p>
        <p>Whether that is enough depends on the country and on the kind of document. Nobody here is a lawyer and this page is not legal advice. As a rough map, the European Union describes three levels:</p>
        <ul className="pub-list">
          <li><b>Simple.</b> What GrowSigning makes. In many countries it can be used for agreements that need no special form.</li>
          <li><b>Advanced.</b> Linked to the signer alone, able to identify them, and made so that any later change to the document shows. GrowSigning does not claim to make these.</li>
          <li><b>Qualified.</b> An advanced signature made with a qualified certificate from a provider approved for that. In EU law only this level is given the same effect as a handwritten signature. GrowSigning does not make these.</li>
        </ul>
        <p><b>Check before you send</b> when a law, a registry, a bank or the other side asks for written form, a handwritten signature, a witness, a notary or a qualified signature. The usual cases are wills, trusts, powers of attorney, sales and transfers of land, long leases, deeds, and in some countries parts of an employment contract. <a href="#outside-us">The notes by country and the list of documents not to sign here</a> say more.</p>
      </QA>

      <QA id="outside-us" q="Signing outside the United States, and documents that should not be signed here">
        <p>GrowSigning was built from reviews that were mostly written in the United States, and it knows nothing about your country. It cannot tell what kind of document you send, beyond looking for the few words listed below, and it has not checked the law of any country for you, the United States included. What follows is what our research found, with the month it was looked at and where it came from. It is not legal advice, laws change, and the rule for your document may differ: check with a lawyer or the office that will receive the document.</p>
        <p><b>Do not sign these here without checking first:</b></p>
        <ul className="pub-list">
          <li>A will or a codicil, a trust deed, a power of attorney.</li>
          <li>A sale or transfer of land or a house, or a long lease.</li>
          <li>A deed or any other document that needs a witness, and anything that has to be signed in front of a notary.</li>
          <li>Anything a law, a registry, a court or a public body says must be on paper, in written form, or signed with an advanced or a qualified signature.</li>
          <li>In Germany: the fixed term in an employment contract, a notice of termination and a separation agreement.</li>
        </ul>
        <p><b>The check before sending.</b> When the subject, the name of a document or the text of a document contains a word that usually means one of these, the review step of the editor shows a warning that names the word and where it stands, and the document's History gets a line that says so. Through the API the same list comes back as <code>warnings</code> in the answer to sending, and from <code>GET /api/envelopes/&#123;id&#125;/warnings</code> before it. It is a reminder and nothing more: it never blocks a send, it only knows the words below, and a document it says nothing about can still need paper.</p>
        <details data-fold="">
          <summary>The words it looks for</summary>
          <p className="muted small" style={{ margin: '8px 0 0' }}>Capitals and accents make no difference, and an umlaut may be written out (ue for ü). The name of a document is usually its file name, and it is read too: underscores and dots count as spaces, so Power_of_Attorney.pdf and PowerOfAttorney.pdf are found. A word followed by three dots stands for every word that begins that way.</p>
          <dl className="pub-words">
            {paperWordList().map((k) => (
              <div key={k.a}>
                <dt>For {k.a}</dt>
                <dd>{k.words.join(', ')}{k.titleOnly.length > 0 && <>. In the subject and in document names only: {k.titleOnly.join(', ')}</>}{k.namesOnly.length > 0 && <>. In document names only: {k.namesOnly.join(', ')}</>}.</dd>
              </div>
            ))}
          </dl>
        </details>
        <p style={{ marginTop: 12 }}><b>Notes by country.</b> A link marked &quot;official&quot; goes to a law or a public authority. The others go to a law firm, a journal or a company writing about the law, because that was all our research could reach.</p>
        <ul className="pub-notes">
          {COUNTRY_NOTES.map((n) => (
            <li key={n.id} id={`country-${n.id}`}>
              <h4>{n.place}</h4>
              <p>{n.text}</p>
              <p className="src">Looked at in {n.checked}. {n.sources.length === 1 ? 'Source' : 'Sources'}: {n.sources.map((s, i) => (
                <span key={s.url}>{i > 0 && '; '}<a href={s.url} rel="noreferrer">{s.label}</a> ({s.official ? 'official' : 'not an official source'})</span>
              ))}.</p>
            </li>
          ))}
        </ul>
        <p className="muted small">Your country is not here? Then we have not looked at it, and that says nothing either way. Where the server and its files are, and who else handles data, is on <Link href="/security#data">Security and trust</Link>.</p>
      </QA>

      <QA id="language" q="Which language do my signers see?">
        <p>{LANGUAGE_NOTE}</p>
        <p>That includes the text every signer has to agree to before signing, the reminders and the certificate. If your signers do not read English, say in your message what they will be asked, or put a short translation on the first page of your document. <a href="#consent-wording">The words of the consent screen are printed on this page</a>, so you can translate them yourself.</p>
      </QA>

      <QA id="cannot-open" q="My signer says the page will not open where they are">
        <p>Some countries and some office networks do not let a website through. We have not tested from which places this one can be reached, so we make no promise about any country. Every email we send in your name that asks someone to sign (the request, the reminders and the notices about it) therefore ends with this line, and a reply to it comes to you. The list a signer gets from Find my documents comes from us and can name several senders, so it tells them to reply to your own email about the document instead.</p>
        <blockquote className="pub-quote"><p>{cannotOpenLine('you')}</p></blockquote>
        <p>When someone writes that to you: open the document, choose <b>More</b>, then <b>Open the PDF</b>, and save the file. It is the document as it stands, with what has been filled in so far. Send it to them yourself, and collect their signature on paper or as a scan.</p>
        <p>A signature collected that way is outside GrowSigning. It is not on our signing record and not in the document's History, so keep the paper or the scan yourself. The document here stays open until you cancel it or its deadline passes. If the others on it should still finish here, take that one person off with a correction instead.</p>
      </QA>

      <QA id="no-email" q="My signer has no email address, or does not read it">
        <p>Type their name and tick <b>{BY_SENDER_TICK}</b> instead of an address. {BY_SENDER_HOW}</p>
        <p>We tell you what only you can pass on: when it becomes their turn after someone before them has finished, the reminders you set for the document, when their link has not been opened for a while, and, in the email that tells you everything is signed, that their copy is waiting behind their link. Their own page never promises them an email.</p>
        <p>The History and the signing record say &quot;{BY_SENDER_LINE}&quot; where an address would be. That is all we know: not how you sent it, not whether it arrived, and not who opened it. If it matters who signs, give them an access code and tell it to them another way, or ask for a one-time code by text message where this server sends texts. You can add their address later: on the document's page, open the More next to their name and choose <b>Change person</b>. From then on we email them, and the link you sent stops working.</p>
      </QA>
    </>
  );
}
