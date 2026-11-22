'use client';
// Ask for a payment, taken here by card (src/server/routes-collect.ts, words in src/lib/collect.ts). Only for a
// document that asks for one; the server says whether it does (GET /sign/:token/collect).
//
// PayAhead: the one line on the document screen, so nobody is surprised by a payment after they sign. It also tells
// the page when a Finish already waits for this payment (back from Stripe's page), so the Pay screen opens again.
// PayNow: the Pay screen. "before": after Finish, in place of Done, until Stripe confirms. "after": on the Done screen.
// The person pays on Stripe's own page, in the same tab; Stripe sends them back to /paid, which brings them here.
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { PAY_SAFE, STARTED, STARTED_MORE, payWho } from '@/lib/collect';

type Collect = { state: 'ahead' | 'ready' | 'started' | 'paid' | 'refunded' | 'partly_refunded' | 'disputed'; merchant: string; account: string; for: string; when: 'before' | 'after'; amount: string | null; line?: string; lines?: string[]; finished?: boolean };
const RETURN_KEY = 'gs-pay-return';
const WAITING = 'Stripe already has this payment. It shows as confirmed here once Stripe sends its confirmation, usually within a minute. You do not need to pay again.';

function useCollect(base: string, poll: boolean, bump = 0) {
  const [c, setC] = useState<Collect | null | undefined>(undefined);
  const tries = useRef(0);
  useEffect(() => {
    let live = true;
    let timer: any;
    const get = () => api<{ collect: Collect | null }>(`${base}/collect`).then((r) => {
      if (!live) return;
      setC(r.collect);
      // While Stripe has not confirmed: ask again every few seconds, for about two minutes.
      if (poll && r.collect?.state === 'started' && tries.current++ < 40) timer = setTimeout(get, 3000);
    }).catch(() => live && setC(null));
    get();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [base, poll, bump]);
  return c;
}

export function PayAhead({ base, onWaiting }: { base: string; onWaiting: () => void }) {
  const c = useCollect(base, false);
  useEffect(() => {
    if (c && c.when === 'before' && (c.state === 'ready' || c.state === 'started')) onWaiting();
  }, [c, onWaiting]);
  if (!c || c.state !== 'ahead' || !c.line) return null;
  return <p className="notice sg-top" role="status" data-feature="ds-pay-collect">{c.line}</p>;
}

export function PayNow({ base, token, onBack, onDone }: { base: string; token: string; onBack?: () => void; onDone?: () => void }) {
  const [bump, setBump] = useState(0);
  const c = useCollect(base, true, bump);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // Before finishing: once Stripe confirmed and the part completed, the page loads the Done screen.
  useEffect(() => {
    if (c && c.when === 'before' && c.finished && onDone) onDone();
  }, [c, onDone]);
  // The Pay screen never leaves someone with nothing to press: back to the document, where Finish says what is next.
  if ((c === null || c?.state === 'ahead') && onBack) return (
    <section className="card" data-feature="ds-pay-collect"><p>There is nothing to pay right now. Go back to the document and press Finish again.</p>
      <button type="button" className="btn lg" style={{ minHeight: 44 }} onClick={onBack}>Back to the document</button></section>
  );
  if (!c || c.state === 'ahead') return null;
  const paid = c.state !== 'ready' && c.state !== 'started';
  const pay = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ url?: string; paid?: true; waiting?: true }>(`${base}/collect/start`, { method: 'POST' });
      if (r.paid) return (setBusy(false), setBump((n) => n + 1));
      if (r.waiting) return (setBusy(false), setNote(WAITING), setBump((n) => n + 1));
      try {
        sessionStorage.setItem(RETURN_KEY, `/sign/${token}`);
      } catch {}
      window.location.assign(r.url!);
    } catch (e: any) {
      setError(e?.message || 'Stripe could not be reached just now. Nothing was charged. Try again in a minute.');
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="sg-paynow-h" data-feature="ds-pay-collect">
      {paid ? (
        <>
          <h2 id="sg-paynow-h">Payment confirmed</h2>
          {(c.lines || []).map((l) => <p key={l}>{l}</p>)}
          {c.when === 'before' && !c.finished && <p role="status">Your signature is being added. This page updates by itself.</p>}
        </>
      ) : (
        <>
          <h2 id="sg-paynow-h">Pay {c.amount}</h2>
          <p>{c.when === 'before' ? `Your signature is ready. To finish, pay ${c.amount} to ${c.merchant} for ${c.for}.` : `${c.merchant} asks you to pay ${c.amount} for ${c.for}. You have already finished signing.`}</p>
          {c.state === 'started' && <p className="notice" role="status"><b>{STARTED}</b> {STARTED_MORE}</p>}
          <p className="small">{PAY_SAFE} {payWho(c.merchant, c.account)}</p>
          {note && <p className="notice" role="status">{note}</p>}
          {error && <div className="notice err" role="alert" id="sg-paynow-error">{error}</div>}
          <div className="row wrap sg-actions">
            <button type="button" className="btn primary lg" style={{ minHeight: 44 }} disabled={busy} onClick={pay} aria-describedby={error ? 'sg-paynow-error' : undefined}>
              {c.state === 'started' ? 'Open the payment page again' : `Pay ${c.amount}`}
            </button>
            {c.state === 'started' && <button type="button" className="btn lg" style={{ minHeight: 44 }} onClick={() => setBump((n) => n + 1)}>Check again</button>}
            {onBack && c.state !== 'started' && <button type="button" className="btn ghost lg" style={{ minHeight: 44 }} onClick={onBack}>Back to the document</button>}
          </div>
        </>
      )}
    </section>
  );
}
