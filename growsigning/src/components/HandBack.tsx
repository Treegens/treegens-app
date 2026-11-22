'use client';
import { useT } from '@/components/sign/lang';

// The last thing someone who signed in person sees, on a device that is not theirs: thank you, and hand it back.
// The host's account is locked in this browser while the signer holds the device (src/server/handover.ts), so the
// one button here leads to the screen that asks for the host's password, and after that to the envelope, where the
// next person who signs in person is waiting under "Host signing now".
export function HandBack({ signer, sender, envelopeId }: { signer: string; sender: string; envelopeId: string }) {
  const T = useT();
  return (
    <section className="card hb" aria-labelledby="hb-h">
      <h2 id="hb-h" className="serif">{T('sign.handback.title', { signer, sender })}</h2>
      <p>{T('sign.handback.body', { sender })}</p>
      <div className="hb-row">
        <a className="btn primary lg" href={`/app/envelopes/${encodeURIComponent(envelopeId)}`}>{T('sign.handback.button', { sender })}</a>
        <span className="muted small">{T('sign.handback.note', { sender })}</span>
      </div>
    </section>
  );
}
