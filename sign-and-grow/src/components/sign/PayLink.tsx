'use client';
import { useEffect, useState } from 'react';
import { api } from '@/components/ui';
import { payForSigner, payNotUs } from '@/lib/paylink';

type Pay = { url: string; host: string; label: string; sender: { name: string; email: string }; account: string };

// The sender's own payment page, offered on the last screen to someone who signs, after they pressed Finish. The
// server decides whether there is one to show (GET /sign/:token/pay in src/server/routes-paylink.ts): it never is
// before Finish, never in an email, and never for an account that has not earned trust. This screen names the
// sender and prints the whole address before the button, so nobody has to trust a button they cannot read.
export function PayLink({ base }: { base: string }) {
  const [pay, setPay] = useState<Pay | null>(null);
  useEffect(() => {
    let live = true;
    api<{ pay: Pay | null }>(`${base}/pay`).then((r) => live && setPay(r.pay)).catch(() => {});
    return () => {
      live = false;
    };
  }, [base]);
  if (!pay) return null;
  // Written down once, so the sender can see it was pressed. Whether anyone paid is never known here.
  const opened = () => void api(`${base}/pay-opened`, { method: 'POST' }).catch(() => {});
  return (
    <section className="card" aria-labelledby="sg-pay-h">
      <h2 id="sg-pay-h">{pay.label}</h2>
      <p>{payForSigner(pay.sender.name)}</p>
      <p className="small" style={{ marginBottom: 4 }}>The button opens this address, which {pay.sender.name}{pay.account ? ` (${pay.account})` : ''} gave us:</p>
      <p style={{ marginTop: 0 }}><code id="sg-pay-url" style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{pay.url}</code></p>
      <div className="row wrap sg-actions">
        {/* noreferrer: the address of this page holds the signing link, and the payment site has no business with it. */}
        <a className="btn primary lg" href={pay.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={opened} aria-describedby="sg-pay-url sg-pay-not-us"
          style={{ whiteSpace: 'normal', minHeight: 44, textAlign: 'center' }}>
          {pay.label} on {pay.host}<span className="sg-vh"> (opens in a new tab)</span>
        </a>
      </div>
      <p className="muted small" id="sg-pay-not-us">{payNotUs(pay.sender.name)} {pay.sender.email && <>Their email: <a href={`mailto:${pay.sender.email}`}>{pay.sender.email}</a>.</>}</p>
    </section>
  );
}
