'use client';

// The last thing someone who signed in person sees, on a device that is not theirs: thank you, and hand it back.
// The host's account is locked in this browser while the signer holds the device (src/server/handover.ts), so the
// one button here leads to the screen that asks for the host's password, and after that to the envelope, where the
// next person who signs in person is waiting under "Host signing now".
export function HandBack({ signer, sender, envelopeId }: { signer: string; sender: string; envelopeId: string }) {
  return (
    <section className="card hb" aria-labelledby="hb-h">
      <h2 id="hb-h" className="serif">Thank you, {signer}. Please hand this device back to {sender}.</h2>
      <p>You have finished signing. This device belongs to {sender}, and there is nothing more for you to do on it.</p>
      <div className="hb-row">
        <a className="btn primary lg" href={`/app/envelopes/${encodeURIComponent(envelopeId)}`}>I am {sender}</a>
        <span className="muted small">For {sender} only. The account is locked on this device and asks for {sender}&apos;s password before it opens.</span>
      </div>
    </section>
  );
}
