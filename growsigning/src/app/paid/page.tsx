'use client';
// Where Stripe's payment page sends a person back (src/server/collect.ts, success_url and cancel_url). The address
// carries no signing link, so Stripe never holds one: the tab that opened Stripe's page kept it, and goes back to it.
import { useEffect, useState } from 'react';

export default function Paid() {
  const [lost, setLost] = useState(false);
  useEffect(() => {
    let to = '';
    try {
      to = sessionStorage.getItem('gs-pay-return') || '';
    } catch {}
    if (/^\/sign\/[A-Za-z0-9_-]+$/.test(to)) window.location.replace(to);
    else setLost(true);
  }, []);
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '48px 16px' }}>
      <h1 style={{ fontSize: 24 }}>Back from the payment page</h1>
      {lost
        ? <p>We could not find the document in this tab. Open the link in the email you got for it. It shows whether the payment is confirmed, and you can finish there.</p>
        : <p role="status">Taking you back to your document.</p>}
    </main>
  );
}
