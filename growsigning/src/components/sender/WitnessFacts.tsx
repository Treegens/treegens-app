'use client';
import { dayTime } from './lib';
import { marksOf, MARK_WORDS, sameDevice, SAME_DEVICE_LIMITS } from '@/lib/witness';

// A witness on the sender's envelope page (src/lib/witness.ts): whose signature they witness, when they are asked,
// what they stated, and what a challenge to the document would look at. Read only. Changing the witness is Correct,
// like for anyone, and saying "I was not there" is the witness's own.

const signerOf = (e: any, r: any) => (e?.recipients || []).find((x: any) => x.id === r.witness_for);

/** Where a witness who has not been asked yet stands, in place of "it goes out when their turn comes". */
export function witnessWait(r: any, e: any): string {
  const s = signerOf(e, r);
  const who = s?.name || 'the person they witness';
  if (e.status !== 'sent') return 'Never sent. The document closed before they were asked.';
  if (r.witness_absent_at) return `Not asked again. ${who} can name another witness, or you can with Change person, in their More.`;
  if (!r.email) return `${who} names the witness on their signing page before they finish. We email the witness straight after.`;
  return `It goes out straight after ${who} has signed, whatever the signing order says.`;
}

export function WitnessFact({ r, e }: { r: any; e: any }) {
  const s = signerOf(e, r);
  // The device is only ever yes or no, said with what that can and cannot show.
  const marks = marksOf(r.witness_marks).filter((m) => m !== 'device');
  const same = sameDevice(r);
  return (
    <>
      <div><dt>Witness for</dt><dd>{s ? s.name : 'Nobody on this document. To choose whose signature they witness, choose More, then Edit.'}{r.signer_named_at ? <span className="muted"> · named by {s?.name || 'the signer'} on {dayTime(r.signer_named_at)}</span> : null}</dd></div>
      {r.witness_statement && <div><dt>Their statement</dt><dd>&ldquo;{r.witness_statement}&rdquo; <span className="muted">Ticked on {dayTime(r.witness_said_at)}. GrowSigning records it and cannot check it.</span></dd></div>}
      {r.witness_absent_at && <div><dt>Not there</dt><dd>Said on {dayTime(r.witness_absent_at)} that they were not there, so the document is not witnessed yet. If nobody else saw {s?.name || 'the signer'} sign, a new witness cannot truthfully say they did: cancel the request and send it again.</dd></div>}
      {same !== null && <div><dt>Same device</dt><dd>{same ? <b className="sn-bad">Yes, the signer&apos;s browser.</b> : 'No.'} <span className="muted">{SAME_DEVICE_LIMITS}</span></dd></div>}
      {marks.length > 0 && <div><dt>Check this</dt><dd><b className="sn-bad">{marks.map((m) => MARK_WORDS[m]).join('; ')}.</b> Allowed, and marked on the certificate, because it is what someone who challenges the document would look at.</dd></div>}
    </>
  );
}
