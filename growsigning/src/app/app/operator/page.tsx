'use client';
import { useState, type FormEvent } from 'react';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';
import { Tickets } from './tickets';
import { LeakCheckLine } from './leakcheck';
import { EncryptionLine } from './encryption';
import { TreeCommitments } from './commitments';
import { AcrobatCheckCard } from './acrobat';
import { ReferralRecord } from './referrals';
import { AccountPeople } from './people';
import { useMe } from '@/components/AppShell';
import { PRICE_NOTICE_DAYS, PAID_TRUST_DAYS, priceChangeDay } from '@/lib/policy';

// The queue for the people who run the service: help requests, reports from recipients, and paused accounts.
// Only visible to the addresses listed in OPERATOR_EMAILS.
// Money questions only a person can settle: who is behind a charge on a card statement, and accounts whose payments
// were switched off by a card dispute.
// Announcing a higher monthly price. Customers are promised notice, and the server holds every renewal to it, so
// this is the first step of any price change: it emails everyone who would pay more and records that they were told.
function PriceNotice() {
  const [usd, setUsd] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any>(null);
  const earliest = new Date(Date.now() + (PRICE_NOTICE_DAYS + 1) * 864e5).toISOString().slice(0, 10);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm(`Email every owner and admin of every account with a monthly plan (also ones whose payment is failing, on hold or paused) that the price becomes $${usd} a month from ${priceChangeDay(`${from}T00:00:00.000Z`)}? Once the emails are out, a later notice can only withdraw it, and everyone told is then told that.`)) return;
    setBusy(true);
    api('/operator/billing/price-notice', { body: { new_usd: Number(usd), from } }).then(setOut).catch(oops).finally(() => setBusy(false));
  };
  return (
    <>
      <h3 style={{ marginTop: 18 }}>Announce a price change</h3>
      <p className="muted small" style={{ margin: '4px 0 10px' }}>Nobody on the plan pays a higher price without {PRICE_NOTICE_DAYS} days&apos; notice. Announce it here first: every owner and admin of every account with a plan, in any state, is emailed the old price, the new one, the day (a calendar day in UTC) and a link that stops their plan. An account counts as told only once the email has left for every one of its owners and admins; the ones that were not reached are listed below and keep their price until they are. Then change the price with the payment provider for that same day. A renewal that charges more without this notice has the difference refunded automatically, and you are told. Accounts that start the plan later pay what their checkout shows. Running it again is safe: accounts already told are skipped. A notice for the same price as now, or a lower one, withdraws a rise announced before and tells everyone who was told of it.</p>
      <form className="row wrap" onSubmit={send}>
        <input value={usd} onChange={(e) => setUsd(e.target.value)} placeholder="New price in dollars, for example 12" aria-label="New monthly price in dollars" inputMode="decimal" required style={{ maxWidth: 280 }} />
        <input type="date" value={from} min={earliest} onChange={(e) => setFrom(e.target.value)} aria-label="First day of the new price" required style={{ maxWidth: 170 }} />
        <button className="btn" disabled={busy || !usd || !from}>{busy ? 'Sending' : 'Tell everyone on the plan'}</button>
      </form>
      {out && (
        <div className="notice" role="status" style={{ marginTop: 12 }}>
          <b>{out.told} {out.told === 1 ? 'account was' : 'accounts were'} told</b> that the plan costs {out.new_price} a month from {out.from_day || priceChangeDay(out.from)}. {out.already_told > 0 && `${out.already_told} had been told already. `}{out.not_affected > 0 && `${out.not_affected} already pay that much or more, so nothing changes for them. `}
          {out.withdrawn > 0 && `${out.withdrawn} had been told of a higher price before: that rise is withdrawn, and their owners and admins were emailed that it is. `}
          {out.not_told.length > 0 && <><b>{out.not_told.length} could not be told</b> because the email did not leave the mail server for every owner and admin ({out.not_told.join('; ')}). They keep their price until they have been. Fix the email problem and run this again. </>}
          {out.on_the_way?.length > 0 && <><b>{out.on_the_way.length} {out.on_the_way.length === 1 ? 'is' : 'are'} still on the way</b>: the mail server has not taken the email yet ({out.on_the_way.join('; ')}). Run this again in a few minutes: an account counts once its email has left, and nobody is emailed twice. </>}
          {out.too_late?.length > 0 && <><b>{out.too_late.length} {out.too_late.length === 1 ? 'was' : 'were'} not told in time</b> for that day: the email would leave, or left, less than {PRICE_NOTICE_DAYS} days before it ({out.too_late.join('; ')}). They keep their price. Announce it again with a later first day for them.</>}
        </div>
      )}
    </>
  );
}

function BillingTools() {
  const [disputed, reload] = useLoad<any>(() => api('/operator/billing/disputed').catch(() => ({ accounts: [] })));
  const [last4, setLast4] = useState('');
  const [on, setOn] = useState('');
  const [amount, setAmount] = useState('');
  const [found, setFound] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const look = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const q = new URLSearchParams({ last4, ...(on ? { charged_on: on } : {}), ...(amount ? { amount } : {}) });
    api(`/operator/billing/lookup?${q}`).then((r) => setFound(r.accounts)).catch(oops).finally(() => setBusy(false));
  };
  const clear = (id: string, name: string) => {
    if (window.confirm(`Switch payments back on for "${name}"? Do this once the dispute is settled and you are satisfied it was a mistake.`))
      api(`/operator/billing/accounts/${id}/clear-dispute`, { method: 'POST' }).then(() => (toast('Payments are back on for that account.'), reload())).catch(oops);
  };
  const who = (a: any) => a.admins.map((u: any) => `${u.name} <${u.email}>`).join(', ') || 'no admins';
  return (
    <div className="card">
      <h2>Billing</h2>
      <p className="muted small" style={{ margin: '4px 0 12px' }}>Someone asks about a charge and does not know which account it is on: the last four digits of the card are enough to look, and a date and amount narrow it down.</p>
      <form className="row wrap" onSubmit={look}>
        <input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Last 4 digits" aria-label="Last four digits of the card" inputMode="numeric" required pattern="[0-9]{4}" style={{ maxWidth: 140 }} />
        <input type="date" value={on} onChange={(e) => setOn(e.target.value)} aria-label="Date of the charge" style={{ maxWidth: 170 }} />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount, for example 9.00" aria-label="Amount of the charge" inputMode="decimal" style={{ maxWidth: 190 }} />
        <button className="btn" disabled={busy}>{busy ? 'Looking' : 'Find the account'}</button>
      </form>
      {found && (found.length === 0 ? <div className="notice" style={{ marginTop: 12 }}>No account was charged on a card ending in {last4} with those details. A charge from the last few minutes may not show up yet.</div> : (
        <ul className="rules" style={{ marginTop: 12 }}>{found.map((a) => (
          <li key={a.id}><b>{a.name}</b> ({a.id}) · {a.free_with ? `free with ${a.free_with}` : a.plan === 'grove' ? 'monthly plan' : 'no plan'}{a.status ? `, ${a.status}` : ''}{a.ends_at ? `, ends ${fmtDate(a.ends_at)}` : a.renews_at ? `, renews ${fmtDate(a.renews_at)}` : ''}{a.disputed ? ', payments off after a dispute' : ''}<div className="muted small">{who(a)}</div></li>
        ))}</ul>
      ))}
      {disputed?.accounts?.length > 0 && (
        <>
          <h3 style={{ marginTop: 18 }}>Payments switched off after a card dispute ({disputed.accounts.length})</h3>
          <ul className="rules" style={{ marginTop: 8 }}>{disputed.accounts.map((a: any) => (
            <li key={a.id}><b>{a.name}</b> ({a.id}) · disputed {fmtDate(a.dispute_at)} · {a.signatures} signatures on the balance<div className="muted small">{who(a)}</div>
              <button className="btn sm" style={{ marginTop: 6 }} onClick={() => clear(a.id, a.name)}>Switch payments back on</button></li>
          ))}</ul>
        </>
      )}
      <PriceNotice />
    </div>
  );
}

export default function Operator() {
  const me = useMe();
  const [q, reload, error] = useLoad(() => api('/operator/queue'));
  if (error) return <div className="card center"><h2>Not available</h2><p className="muted">This page is for the team that runs GrowSigning.</p></div>;
  if (!q) return <div className="muted">Loading…</div>;
  const act = (p: Promise<any>, msg: string) => p.then(() => (toast(msg), reload())).catch(oops);
  const pause = (id: string, name: string) => {
    const reason = window.prompt(`Pause sending for "${name}"? They are told why, and keep access to every document. Reason shown to them:`, 'Reports from recipients');
    if (reason !== null) act(api(`/operator/accounts/${id}`, { body: { paused: true, reason } }), 'Sending paused. The account admins were emailed.');
  };
  // Trusting is how a person lifts the daily limit and the check for fake payment notices, which is what the
  // refusals for both promise. It changes nothing else: a trusted account can still be reported and paused.
  const trust = (id: string, name: string, on: boolean) => {
    const ask = on ? `Trust "${name}"? The daily limit on how many people it can send to, and the check for fake payment notices, stop applying to it. The account admins are told.`
      : `Remove trust from "${name}"? Unless it has a payment that is at least ${PAID_TRUST_DAYS} days old and was not refunded or disputed, the daily limit and the check for fake payment notices apply to it again. The account admins are told.`;
    if (window.confirm(ask)) act(api(`/operator/accounts/${id}`, { body: { trusted: on } }), on ? 'Trusted. The account admins were emailed.' : 'Trust removed. The account admins were emailed.');
  };
  const plan = (p: string) => (p === 'seedling' ? 'free plan' : p === 'grove' ? 'monthly plan' : p);
  const trustButton = (id: string, name: string, trustedAt: string | null) => (
    <button className="btn sm" onClick={() => trust(id, name, !trustedAt)}>{trustedAt ? 'Remove trust' : 'Trust this account'}</button>
  );
  // The account a request or a report is about: what decides between answering, trusting and pausing.
  const about = (x: any) => (x.about_account
    ? <div className="small" style={{ margin: '4px 0 8px' }}>Account <b>{x.account_name}</b> · {plan(x.account_plan)} · created {fmtDate(x.account_created_at)} · {x.account_trusted_at ? `trusted since ${fmtDate(x.account_trusted_at)}` : 'not trusted'}{x.suspended_at ? ' · paused' : ''}<AccountPeople id={x.about_account} /></div>
    : <div className="small muted" style={{ margin: '4px 0 8px' }}>No account goes with this address: they were not signed in, and no confirmed account owner uses it.</div>);
  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">Review queue</h1><div className="muted">Every item here is a person waiting. Answer a help request right here: the answer is emailed to them and kept with the request.</div></div><button className="btn" onClick={reload}>Refresh</button></div>

      <LeakCheckLine />
      <EncryptionLine />

      {/* A server under a government agreement has no plan and its billing routes answer 404: no money tools there. */}
      {!me?.agreement && <BillingTools />}

      {/* Help requests as tickets: the queue by due time, the thread, and every action an operator can take. */}
      <Tickets accountActions={(a) => trustButton(a.id, a.name, a.trusted_at)} />

      <div className="card pad0">
        <div style={{ padding: '14px 16px' }}><h2>Reports from recipients <span className="muted" style={{ fontWeight: 400 }}>({q.reports.length})</span></h2><div className="muted small">Three different recipients reporting one account pauses it automatically. Reports you mark as abuse keep counting towards that. Reports you dismiss do not, and neither do reports from visitors of a public form: such a visitor typed their own name and address, so only you decide what those mean. A report stays here when the sender has deleted the document since.</div></div>
        {q.reports.length === 0 && <div className="empty" style={{ padding: 24 }}>No open reports.</div>}
        {q.reports.map((r: any) => (
          <div key={r.id} className="queue-item">
            <div className="row between wrap"><b>{r.clickwrap_id ? `Click-to-agree page: ${r.clickwrap_name || 'deleted since'}` : r.envelope_deleted ? 'A document its sender has deleted since' : r.subject}</b><span className="muted small">{r.reason} · {fmtDate(r.at, true)}</span></div>
            {/* A report from the page of click-to-agree terms: anyone can open that page, so it never counts towards the pause. */}
            {r.clickwrap_id ? <div className="small">{r.clickwrap_slug && <><a href={`/agree/${r.clickwrap_slug}`} target="_blank" rel="noreferrer">Open the page</a>. </>}Reported by {r.reporter}. Anyone can open such a page, so the report does not count towards the automatic pause.</div>
              : <div className="small">{r.envelope_deleted ? 'Nothing of the document is left. ' : `Sent by ${r.sender_name} (${r.sender_email}). `}Reported by {/^link:/.test(r.reporter || '') ? 'a person with no email address here, whose link the sender shared' : r.reporter}.</div>}
            {r.via_form && !r.clickwrap_id && <div className="small" style={{ marginTop: 4 }}><span className="badge">Public form</span> This person came through a public form and typed their own name and address. The report does not count towards the automatic pause.</div>}
            {about(r)}
            {r.message && <pre>{r.message}</pre>}
            {r.detail && <div className="small" style={{ marginBottom: 10 }}>The recipient wrote: {r.detail}</div>}
            <div className="row wrap">
              <button className="btn sm" onClick={() => act(api(`/operator/reports/${r.id}`, { body: { status: 'dismissed' } }), 'Dismissed')}>Nothing wrong</button>
              <button className="btn sm" onClick={() => act(api(`/operator/reports/${r.id}`, { body: { status: 'upheld' } }), 'Marked as abuse')}>This was abuse</button>
              {!r.suspended_at && <button className="btn sm danger" onClick={() => pause(r.account_id, r.account_name)}>Pause this sender</button>}
              {trustButton(r.account_id, r.account_name, r.account_trusted_at)}
              {/@/.test(r.reporter || '') && <a className="btn sm ghost" href={`mailto:${r.reporter}`}>Email the reporter</a>}
            </div>
          </div>
        ))}
      </div>

      <div className="card pad0">
        <div style={{ padding: '14px 16px' }}><h2>Paused accounts <span className="muted" style={{ fontWeight: 400 }}>({q.paused.length})</span></h2><div className="muted small">Pausing stops everything a sender starts from being emailed: new sends, new or changed recipients, reminders, reopening, team invitations and notices about a change, and people further down a signing order are not asked. The account keeps every document and can export, can still void (the notice goes without the reason), and people who already have a document can still sign it. Lifting a pause closes the reports that led to it and asks everyone who was held back.</div></div>
        {q.paused.length === 0 && <div className="empty" style={{ padding: 24 }}>No accounts are paused.</div>}
        {q.paused.map((a: any) => (
          <div key={a.id} className="queue-item row between wrap">
            <div><b>{a.name}</b> <span className="muted small">{plan(a.plan)} · created {fmtDate(a.created_at)} · {a.trusted_at ? `trusted since ${fmtDate(a.trusted_at)}` : 'not trusted'} · paused {fmtDate(a.suspended_at, true)}</span><div className="small">{a.suspended_reason}</div><AccountPeople id={a.id} /></div>
            <div className="row wrap">
              {trustButton(a.id, a.name, a.trusted_at)}
              <button className="btn sm primary" onClick={() => act(api(`/operator/accounts/${a.id}`, { body: { paused: false } }), 'Sending is back on. The account admins were emailed.')}>Lift the pause</button>
            </div>
          </div>
        ))}
      </div>

      {/* Whether Adobe Acrobat still shows our time stamps as valid, from the program that checks it (acrobat.tsx). */}
      <AcrobatCheckCard />

      {/* Invite a friend: who invited whom, folded (referrals.tsx). Nothing while nobody has been invited. */}
      <ReferralRecord />

      {/* Not a person waiting: the table of contracts, folded, after everything that is. */}
      <TreeCommitments />
    </div>
  );
}
