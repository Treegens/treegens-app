'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';
import { PLANS, type PlanId } from '@/lib/impact';
import { FindSubscription, StopByCard, billDay } from '@/app/help/tools';

// price: the monthly price this account is charged (in dollars), and next_amount the next charge as the Plan page
// states it. Never the price for new customers: this page is where someone decides whether to stop.
type Info = { account: string; plan: string; price: number; next_amount?: string; renews_at: string | null; ends_at: string | null; signatures_left?: number; can_cancel?: boolean; cancel_ref?: string | null; free_with?: string | null; failing?: boolean };
type Done = { ends_at: string; reference: string; ended_now?: boolean; why?: string };
type View = { kind: 'loading' } | { kind: 'no-link' } | { kind: 'expired' } | { kind: 'failed'; message: string } | { kind: 'ready'; info: Info };

const planName = (plan: string) => PLANS[plan as PlanId]?.name || plan;
// Dollars as a price is written: 12, or 9.50.
const usd = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const Head = ({ title, children }: { title: string; children?: ReactNode }) => (
  <header className="pub-top">
    <h1 className="pub-h1">{title}</h1>
    {children && <p className="pub-lead">{children}</p>}
  </header>
);

// For people whose link cannot be used: two other ways to stop, neither needs a login.
function OtherWays({ lead }: { lead: string }) {
  return (
    <>
      <div className="card">
        <h2 style={{ fontFamily: 'var(--sans)', fontSize: 18, marginBottom: 6 }}>Find my subscription</h2>
        <p className="muted">{lead}</p>
        <FindSubscription label="Email address of the account" />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ fontFamily: 'var(--sans)', fontSize: 18, marginBottom: 6 }}>Stop billing with my card</h2>
        <p className="muted">No access to that mailbox any more, or not sure which address the account is under? Enter the last four digits of the card being charged, plus either the account email address or the date and amount of a charge.</p>
        <StopByCard />
      </div>
      <p className="muted small" style={{ marginTop: 16 }}>Neither works for you? <Link href="/help?topic=billing#contact">Write to us</Link> and a person will stop it. You do not need to log in.</p>
    </>
  );
}

export function StopView() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [nothing, setNothing] = useState('');
  const [tries, setTries] = useState(0);
  const result = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') || '';
    setToken(t);
    if (!t) return setView({ kind: 'no-link' });
    let live = true;
    setView({ kind: 'loading' });
    api<Info>(`/public/billing/stop?token=${encodeURIComponent(t)}`)
      .then((info) => live && setView({ kind: 'ready', info }))
      .catch((e) => live && setView(e?.status === 410 ? { kind: 'expired' } : { kind: 'failed', message: e?.status ? e.message : 'We could not reach Sign&Grow. Check your connection and try again.' }));
    return () => {
      live = false;
    };
  }, [tries]);
  useEffect(() => {
    if (done) result.current?.focus();
  }, [done]);

  async function stop() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setDone(await api<Done>('/public/billing/stop', { body: { token } }));
    } catch (e: any) {
      if (e?.status === 410) setView({ kind: 'expired' });
      else if (!e?.status) setError('We could not reach Sign&Grow, so nothing was changed. Check your connection and press the button again.');
      else if (e.status === 429) setError('That is too many tries for now. Wait an hour, or use the help page and a person will stop it for you.');
      // The server's own words already say what to do when they can (and whether anything changed). Only a bare
      // answer from the payment provider gets ours added.
      else if (e.status >= 500) {
        const said = String(e.message || '');
        const fallback = /a person/i.test(said) ? '' : ' If it keeps failing, use the help page and a person will stop it for you.';
        setError(/try again/i.test(said) ? `${said}${fallback}` : `${said} Press the button again in a minute.${fallback}`);
      }
      // The server found no monthly plan to stop (for example a plan that is free with a code). That is good news, not an error.
      else setNothing(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (view.kind === 'loading') return <Head title="Stop renewing"><span role="status">Finding your plan.</span></Head>;

  if (view.kind === 'no-link')
    return (
      <>
        <Head title="Stop a subscription">This page opens from the link in our billing emails. You can also stop a plan right here, without that link and without logging in.</Head>
        <OtherWays lead="Enter your email address. We email you every paid plan tied to it, each with a link that stops it." />
      </>
    );

  if (view.kind === 'expired')
    return (
      <>
        <Head title="This link is too old to use">Stop links stop working after a few months, and this one is past that or incomplete. Nothing was changed. Get a fresh link below. It takes a minute.</Head>
        <OtherWays lead="Enter your email address and we send a new stop link for every paid plan tied to it." />
      </>
    );

  if (view.kind === 'failed')
    return (
      <>
        <Head title="Stop renewing" />
        <div className="notice err" role="alert">{view.message}</div>
        <div className="pub-actions-row">
          <button type="button" className="btn primary" onClick={() => setTries((n) => n + 1)}>Try again</button>
          <Link href="/help#cancel" className="btn">Other ways to stop</Link>
        </div>
      </>
    );

  const { info } = view;
  const ends = done?.ends_at || info.ends_at;
  const n = info.signatures_left;
  const left = typeof n === 'number' ? `The ${n} signature${n === 1 ? '' : 's'} you have left never expire${n === 1 ? 's' : ''}.` : 'The ones you have left never expire.';

  const reference = done?.reference || info.cancel_ref;
  if (done?.ended_now)
    return (
      <>
        <Head title="Renewal stopped" />
        <div ref={result} tabIndex={-1} role="status" className="card pub-verdict good pub-focus">
          <span className="badge completed">You will not be charged again</span>
          <h2>The monthly plan for {info.account} has ended</h2>
          {reference && <p>Cancellation reference <span className="pub-ref">{reference}</span></p>}
          <ul className="pub-list">
            <li>{done.why === 'not_taken' ? 'The payment for the new month had not been taken yet, so the plan ended today and that payment is withdrawn.' : done.why === 'already_ended' ? 'The plan had already ended with the payment provider, so there was nothing more to stop.' : 'The last payment had not gone through, so the plan ended today and that payment will not be tried again.'}</li>
            <li><b>Your signatures stay yours.</b> {left}</li>
            <li><b>Nothing is deleted.</b> Every document, audit trail and receipt stays in the account, and you can export all of it for free.</li>
            <li>If a charge ever appears after today, the software refunds it by itself.</li>
            <li>We emailed this confirmation to the admins of the account.</li>
          </ul>
        </div>
      </>
    );

  if (done || info.ends_at)
    return (
      <>
        <Head title={done ? 'Renewal stopped' : 'Already stopped'} />
        <div ref={result} tabIndex={-1} role="status" className="card pub-verdict good pub-focus">
          <span className="badge completed">You will not be charged again</span>
          <h2>{planName(info.plan)} for {info.account} ends on {billDay(ends)}</h2>
          {reference && <p>Cancellation reference <span className="pub-ref">{reference}</span></p>}
          {done && !reference && <p className="muted">There is no reference on file for this cancellation. It is stopped all the same.</p>}
          <ul className="pub-list">
            <li>The plan runs until {billDay(ends)}, because that month is already paid for. No payment is taken after that.</li>
            <li><b>Your signatures stay yours.</b> {left}</li>
            <li><b>Nothing is deleted.</b> Every document, audit trail and receipt stays in the account, and you can export all of it for free.</li>
            <li>If a charge ever appears after {billDay(ends)}, the software refunds it by itself.</li>
            {done && <li>We emailed this confirmation to the admins of the account.</li>}
          </ul>
          {error && <div className="notice err" role="alert" style={{ marginTop: 14 }}>{error}</div>}
        </div>
        <p className="muted small" style={{ marginTop: 16 }}>Changed your mind? <Link href="/app/settings?tab=billing">Sign in and resume the plan</Link> any time before {billDay(ends)}. Want the last charge back? See the <Link href="/help#refunds">refund rule</Link>.</p>
      </>
    );

  // A plan on hold after a failed payment is not on "grove" any more, but there is still something to stop.
  if ((info.plan !== 'grove' && !info.can_cancel) || info.free_with || nothing)
    return (
      <>
        <Head title="Nothing to stop" />
        <div className="card pub-verdict good" role="status">
          <span className="badge completed">No charges</span>
          <h2>{info.account} has no paid monthly plan</h2>
          <p>{nothing || (info.free_with ? `The monthly plan is free with the code ${info.free_with}. Nothing is being charged for it and nothing will be.` : 'Nothing is being charged on this account and nothing will be.')} Every document is still there, and so are any signatures the account has left.</p>
        </div>
        <section className="pub-aside" aria-labelledby="other-h">
          <h2 id="other-h">Still seeing a charge from us?</h2>
          <p>It may belong to a different account or email address. Look it up here.</p>
        </section>
        <OtherWays lead="Enter each email address you might have used. We email you every paid plan tied to it, each with a link that stops it." />
      </>
    );

  return (
    <>
      <Head title="Stop renewing">One button. No login, no questions, and you keep everything.</Head>
      <div className="card">
        <dl className="pub-facts" style={{ marginTop: 0 }}>
          <dt>Account</dt>
          <dd>{info.account}</dd>
          <dt>Plan</dt>
          <dd>{planName('grove')}, US${usd(info.price)} a month{info.failing ? ' (the last payment did not go through)' : ''}</dd>
          {info.renews_at && <><dt>Next charge</dt><dd>{info.next_amount ? `US${info.next_amount}` : `US$${usd(info.price)}`} on {billDay(info.renews_at)}</dd></>}
          {typeof n === 'number' && <><dt>Signatures left</dt><dd>{n}<small>They stay yours after you stop</small></dd></>}
        </dl>
        {error && <div className="notice err" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
        <div className="pub-actions-row" style={{ marginTop: 0 }}>
          <button type="button" className="btn primary lg" disabled={busy} onClick={stop}>{busy ? 'Stopping' : 'Stop renewing'}</button>
        </div>
        <ul className="pub-list muted small" style={{ margin: '18px 0 0' }}>
          <li>You are not charged again. {info.failing ? 'The last payment did not go through, so the plan ends today and that payment is not tried again.' : 'The plan runs until the end of the month you already paid for.'}</li>
          <li>The signatures you have left stay yours and never expire. Nothing is deleted.</li>
          <li>You get a cancellation reference here and by email.</li>
        </ul>
      </div>
      <p className="muted small" style={{ marginTop: 16 }}>Not your account, or not what you expected? <Link href="/help?topic=billing#contact">Write to us</Link> and a person will look at it.</p>
    </>
  );
}
