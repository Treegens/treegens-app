'use client';
import { useEffect, useState } from 'react';
import { api } from '@/components/ui';
import { payForSigner, payNotUs, payWhere } from '@/lib/paylink';

type Pay = { url: string; host: string; label: string; sender: { name: string; email: string }; account: string };
type Answer = { pay: Pay | null; later?: string | null };

// The sender's own payment page, offered on the last screen to someone who signs, after they pressed Finish. The
// server decides whether there is one to show (GET /sign/:token/pay in src/server/routes-paylink.ts): it never is
// before Finish, never in an email or a certificate, never to the sender's own team, and never for an account that
// has not earned trust or an address whose name leads into a private network. This screen names the
// sender and prints the whole address before the button, so nobody has to trust a button they cannot read.
export function PayLink({ base }: { base: string }) {
  const [got, setGot] = useState<Answer | null>(null);
  useEffect(() => {
    let live = true;
    api<Answer>(`${base}/pay`).then((r) => live && setGot(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, [base]);
  const pay = got?.pay;
  // The address could not be checked just now (src/server/paydns.ts): said, so nobody waits for a button that is late.
  if (!pay) return got?.later ? <p className="notice" role="status">{got.later}</p> : null;
  // Written down once for each address, with the address this page showed, so the sender can see it was pressed. A
  // middle click counts too; a long press that opens a new tab sends nothing, which is why the sender's page says "not
  // recorded as pressed" and never "not pressed". Whether anyone paid is never known here.
  const opened = () => void api(`${base}/pay-opened`, { method: 'POST', body: { url: pay.url } }).catch(() => {});
  return (
    <section className="card" aria-labelledby="sg-pay-h">
      <h2 id="sg-pay-h">{pay.label}</h2>
      <p>{payForSigner(pay.sender.name)}</p>
      <p className="small" style={{ marginBottom: 4 }}>The button opens this address, which {pay.sender.name}{pay.account ? ` (${pay.account})` : ''} gave us:</p>
      <p style={{ marginTop: 0, marginBottom: 4 }}><code id="sg-pay-url" style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{pay.url}</code></p>
      <p className="small" id="sg-pay-where" style={{ marginTop: 0 }}>{payWhere(pay.sender.name)}</p>
      <div className="row wrap sg-actions">
        {/* noreferrer: the address of this page holds the signing link, and the payment site has no business with it.
            A long host name wraps inside the button instead of pushing the page sideways on a phone. */}
        <a className="btn primary lg" href={pay.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={opened} onAuxClick={opened} aria-describedby="sg-pay-url sg-pay-where sg-pay-not-us"
          style={{ whiteSpace: 'normal', minHeight: 44, textAlign: 'center', maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          {pay.label} on {pay.host}<span className="sg-vh"> (opens in a new tab)</span>
        </a>
      </div>
      <p className="muted small" id="sg-pay-not-us">{payNotUs(pay.sender.name)} {pay.sender.email && <>Their email: <a href={`mailto:${pay.sender.email}`}>{pay.sender.email}</a>.</>}</p>
    </section>
  );
}
