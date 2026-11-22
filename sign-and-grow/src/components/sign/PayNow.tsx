'use client';
// Ask for a payment, taken here by card (src/server/routes-collect.ts, words in src/locales/en.json "sign.pay.*").
// Only for a document that asks for one; the server says whether it does (GET /sign/:token/collect).
//
// PayAhead: the one line on the document screen, so nobody is surprised by a payment after they sign. Back from
// Stripe's page with a Finish that waits for this payment, it opens the Pay screen again, once per page load: after
// "Back to the document" it does not, so the person can change an answer or decline from Other actions.
// PayNow: the Pay screen for "pay before finishing", after Finish and in place of Done, until Stripe confirms.
// PayAfter: for "pay after finishing", the same Pay screen between Finish and Done, with "Not now" going on to Done,
// where one line keeps the way back to it. The person pays on Stripe's own page, in the same tab; Stripe sends them
// back to /paid, which brings them here.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/components/ui';
import { useT } from './lang';

type Collect = { state: 'ahead' | 'ready' | 'started' | 'paid' | 'refunded' | 'partly_refunded' | 'disputed'; merchant: string; account: string; for: string; when: 'before' | 'after'; amount: string | null; field?: string | null; line?: string; lines?: string[]; finished?: boolean };
const RETURN_KEY = 'gs-pay-return';
/** The signing links whose Pay screen was already shown in this page load: it is not forced open again. */
const shown = new Set<string>();
const due = (c: Collect | null | undefined) => !!c && (c.state === 'ready' || c.state === 'started');

function useCollect(base: string, poll: boolean, bump = 0, on = true) {
  const [c, setC] = useState<Collect | null | undefined>(undefined);
  const tries = useRef(0);
  useEffect(() => {
    if (!on) return;
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
  }, [base, poll, bump, on]);
  return c;
}

export function PayAhead({ base, onWaiting }: { base: string; onWaiting: () => void }) {
  const T = useT();
  const c = useCollect(base, false);
  const waits = !!c && c.when === 'before' && due(c);
  useEffect(() => {
    if (waits && !shown.has(base)) {
      shown.add(base);
      onWaiting();
    }
  }, [waits, base, onWaiting]);
  if (!c) return null;
  // Back on the document after Finish: what is left, said once, without forcing the Pay screen open again.
  if (waits) return <p className="notice sg-top" role="status" data-feature="ds-pay-collect">{T('sign.pay.waits', { amount: c.amount })}</p>;
  if (c.state !== 'ahead') return null;
  const how = c.amount || T('sign.pay.amount_in', { field: c.field || T('sign.pay.amount') });
  return <p className="notice sg-top" role="status" data-feature="ds-pay-collect">{T(c.when === 'before' ? 'sign.pay.ahead_before' : 'sign.pay.ahead_after', { how, merchant: c.merchant, what: c.for })}</p>;
}

/** "Pay before finishing": the Pay screen after Finish. */
export function PayNow({ base, token, onBack, onDone }: { base: string; token: string; onBack?: () => void; onDone?: () => void }) {
  const T = useT();
  const [bump, setBump] = useState(0);
  const c = useCollect(base, true, bump);
  // Shown now, so coming back to the document does not open it again by itself.
  useEffect(() => void shown.add(base), [base]);
  // Once Stripe confirmed and the part completed, the page loads the Done screen.
  useEffect(() => {
    if (c && c.when === 'before' && c.finished && onDone) onDone();
  }, [c, onDone]);
  // The Pay screen never leaves someone with nothing to press: back to the document, where Finish says what is next.
  if ((c === null || c?.state === 'ahead') && onBack) return (
    <section className="card" data-feature="ds-pay-collect"><p>{T('sign.pay.nothing')}</p>
      <button type="button" className="btn lg" style={{ minHeight: 44 }} onClick={onBack}>{T('sign.pay.back')}</button></section>
  );
  if (!c || c.state === 'ahead') return null;
  if (!due(c)) return <Confirmed c={c} />;
  return <PayScreen c={c} base={base} token={token} again={() => setBump((n) => n + 1)} onBack={onBack} backLabel={T('sign.pay.back')} />;
}

/**
 * "Pay after finishing": the Pay screen comes between Finish and Done, with one main button and "Not now". After Not
 * now, Done shows one line with the way back. Once Stripe confirmed: Done, with the confirmation under it.
 */
export function PayAfter({ base, token, on, children }: { base: string; token: string; on: boolean; children: ReactNode }) {
  const T = useT();
  const [bump, setBump] = useState(0);
  const c = useCollect(base, true, bump, on);
  const [later, setLater] = useState(false);
  const open = on && !!c && c.when === 'after' && due(c);
  if (open && !later) return <PayScreen c={c!} base={base} token={token} again={() => setBump((n) => n + 1)} onBack={() => setLater(true)} backLabel={T('sign.pay.not_now')} />;
  return (
    <>
      {open && (
        <p className="notice" role="status" data-feature="ds-pay-collect" style={{ marginBottom: 12 }}>
          {T('sign.pay.still', { amount: c!.amount, merchant: c!.merchant })}{' '}
          <button type="button" className="sg-link" style={{ minHeight: 44 }} onClick={() => setLater(false)}>{T('sign.pay.now')}</button>
        </p>
      )}
      {children}
      {on && c && c.state !== 'ahead' && !due(c) && <div style={{ marginTop: 12 }}><Confirmed c={c} /></div>}
    </>
  );
}

function Confirmed({ c }: { c: Collect }) {
  const T = useT();
  return (
    <section className="card" aria-labelledby="sg-paynow-h" data-feature="ds-pay-collect">
      <h2 id="sg-paynow-h">{T('sign.pay.confirmed')}</h2>
      {(c.lines || []).map((l) => <p key={l}>{l}</p>)}
      {c.when === 'before' && !c.finished && <p role="status">{T('sign.pay.adding')}</p>}
    </section>
  );
}

function PayScreen({ c, base, token, again, onBack, backLabel }: { c: Collect; base: string; token: string; again: () => void; onBack?: () => void; backLabel: string }) {
  const T = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const pay = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ url?: string; paid?: true; waiting?: true }>(`${base}/collect/start`, { method: 'POST' });
      if (r.paid) return (setBusy(false), again());
      if (r.waiting) return (setBusy(false), setNote(T('sign.pay.waiting')), again());
      try {
        sessionStorage.setItem(RETURN_KEY, `/sign/${token}`);
      } catch {}
      window.location.assign(r.url!);
    } catch (e: any) {
      setError(e?.message || T('sign.pay.unreachable'));
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="sg-paynow-h" data-feature="ds-pay-collect">
      <h2 id="sg-paynow-h">{T('sign.pay.title', { amount: c.amount })}</h2>
      <p>{T(c.when === 'before' ? 'sign.pay.before' : 'sign.pay.after', { amount: c.amount, merchant: c.merchant, what: c.for })}</p>
      {c.state === 'started' && <p className="notice" role="status"><b>{T('sign.pay.started')}</b> {T('sign.pay.started_more')}</p>}
      <p className="small">{T('sign.pay.safe')} {c.account && c.account !== c.merchant ? T('sign.pay.who_account', { merchant: c.merchant, account: c.account }) : T('sign.pay.who', { merchant: c.merchant })}</p>
      {note && <p className="notice" role="status">{note}</p>}
      {error && <div className="notice err" role="alert" id="sg-paynow-error">{error}</div>}
      <div className="row wrap sg-actions">
        <button type="button" className="btn primary lg" style={{ minHeight: 44 }} disabled={busy} onClick={pay} aria-describedby={error ? 'sg-paynow-error' : undefined}>
          {c.state === 'started' ? T('sign.pay.again') : T('sign.pay.button', { amount: c.amount })}
        </button>
        {c.state === 'started' && <button type="button" className="btn lg" style={{ minHeight: 44 }} onClick={again}>{T('sign.pay.check')}</button>}
        {onBack && <button type="button" className="btn ghost lg" style={{ minHeight: 44 }} onClick={onBack}>{backLabel}</button>}
      </div>
    </section>
  );
}
