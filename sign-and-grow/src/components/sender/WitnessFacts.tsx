'use client';
import { dayTime } from './lib';
import { marksOf, MARK_WORDS } from '@/lib/witness';

// A witness on the sender's envelope page (src/lib/witness.ts): whose signature they witness, when they are asked,
// what they stated, and what a challenge to the document would look at. Read only. Changing the witness is Correct,
// like for anyone, and saying "I was not there" is the witness's own.

const signerOf = (e: any, r: any) => (e?.recipients || []).find((x: any) => x.id === r.witness_for);

/** Where a witness who has not been asked yet stands, in place of "it goes out when their turn comes". */
export function witnessWait(r: any, e: any): string {
  const s = signerOf(e, r);
  const who = s?.name || 'the person they witness';
  if (e.status !== 'sent') return 'Never sent. The envelope closed before they were asked.';
  if (r.witness_absent_at) return `Not asked again. They said on ${dayTime(r.witness_absent_at)} that they were not there when ${who} signed. ${who} can name another witness, or you can with Correct.`;
  if (!r.email) return `${who} names the witness on their signing page before they finish. We email the witness straight after.`;
  return `It goes out straight after ${who} has signed, whatever the signing order says.`;
}

export function WitnessFact({ r, e }: { r: any; e: any }) {
  const s = signerOf(e, r);
  const marks = marksOf(r.witness_marks);
  return (
    <>
      <div><dt>Witness for</dt><dd>{s ? s.name : 'Nobody on this envelope. Choose whose signature they witness by changing the envelope.'}{r.signer_named_at ? <span className="muted"> · named by {s?.name || 'the signer'} on {dayTime(r.signer_named_at)}</span> : null}</dd></div>
      {r.witness_statement && <div><dt>Their statement</dt><dd>&ldquo;{r.witness_statement}&rdquo; <span className="muted">Ticked on {dayTime(r.witness_said_at)}. Sign&amp;Grow records it and cannot check it.</span></dd></div>}
      {r.witness_absent_at && <div><dt>Not there</dt><dd>Said on {dayTime(r.witness_absent_at)} that they were not there, so the document is not witnessed yet. If nobody else saw {s?.name || 'the signer'} sign, a new witness cannot truthfully say they did: void the envelope and send it again.</dd></div>}
      {marks.length > 0 && <div><dt>Check this</dt><dd><b className="sn-bad">{marks.map((m) => MARK_WORDS[m]).join('; ')}.</b> Allowed, and marked on the certificate, because it is what someone who challenges the document would look at.</dd></div>}
    </>
  );
}
