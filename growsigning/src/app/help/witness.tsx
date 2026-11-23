import { WHO_MAY_WITNESS, WITNESS_RECORDS, WITNESS_CHECKED, WITNESS_SOURCE, SAME_DEVICE_LIMITS } from '@/lib/witness';

// "Can a signature be witnessed here?" on /help: what the witness role does, what it does not, and the one official
// source the research behind it cites, with the month it was read. Short and cautious on purpose: GrowSigning records
// what a witness states and cannot check it, and whether that is accepted is for the law and whoever receives the
// document to say. The rules and the words are in src/lib/witness.ts.
export function WitnessHelp() {
  return (
    <article className="pub-qa" id="witness">
      <h3>Can a signature be witnessed here?</h3>
      <p>Some documents need a second person who was physically there to sign as witness: a deed in England and Wales, for example. In the editor, add a person, choose <b>Is a witness</b> as what they do, and choose whose signature they witness. Name the witness yourself, or let the person who signs name them on their review screen before they finish. In step 2, <b>Place the witness block</b> puts their signature, name, address, occupation and the date next to that person&apos;s signature. For a document that needs two witnesses, choose <b>Add a second witness</b> under the first: both are asked at the same time, and each makes their own statement.</p>
      <p>We email the witness straight after that person has signed, whatever the signing order says. Their first screen asks them to confirm, as their own statement, that they were physically present and saw the person sign on that date. Only then do they fill in their block and sign. Someone who was not there says so instead: nothing is signed, the sender is told, and so is the signer when we can email them, and the signer can name the person who was. Anything the witness writes then goes to the sender only. A witness cannot decline the document or pass it on. Being a witness uses none of your signatures.</p>
      <p>{WHO_MAY_WITNESS}</p>
      <p><b>What it does not do.</b> {WITNESS_RECORDS} A witness at the same email address as the signer, under the signer&apos;s own name, or in the browser the signer signed in is allowed, and the signing record and the audit trail mark it, because that is what someone who challenges the document would look at. You are emailed when it happens. For the device you see only yes or no: {SAME_DEVICE_LIMITS}</p>
      <p><b>Deeds in England and Wales.</b> A deed needs a witness who is physically present when it is signed. HM Land Registry also has rules of its own for deeds it registers, and they have changed more than once. Read its <a href={WITNESS_SOURCE} target="_blank" rel="noreferrer">practice guide 8, execution of deeds</a> before you send it anything, and if in doubt, sign on paper. Do not use GrowSigning for a will or a lasting power of attorney.</p>
      <p className="muted small">Written in {WITNESS_CHECKED}, from what our research read then. It is not legal advice.</p>
    </article>
  );
}
