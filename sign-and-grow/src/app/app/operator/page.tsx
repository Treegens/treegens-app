'use client';
import { useState, type FormEvent } from 'react';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';

// The queue for the people who run the service: help requests, reports from recipients, and paused accounts.
// Only visible to the addresses listed in OPERATOR_EMAILS.
// Money questions only a person can settle: who is behind a charge on a card statement, and accounts whose payments
// were switched off by a card dispute.
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
    </div>
  );
}

export default function Operator() {
  const [q, reload, error] = useLoad(() => api('/operator/queue'));
  if (error) return <div className="card center"><h2>Not available</h2><p className="muted">This page is for the team that runs Sign&Grow.</p></div>;
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
      : `Remove trust from "${name}"? If it has not paid, the daily limit and the check for fake payment notices apply to it again. The account admins are told.`;
    if (window.confirm(ask)) act(api(`/operator/accounts/${id}`, { body: { trusted: on } }), on ? 'Trusted. The account admins were emailed.' : 'Trust removed. The account admins were emailed.');
  };
  const plan = (p: string) => (p === 'seedling' ? 'free plan' : p === 'grove' ? 'monthly plan' : p);
  const trustButton = (id: string, name: string, trustedAt: string | null) => (
    <button className="btn sm" onClick={() => trust(id, name, !trustedAt)}>{trustedAt ? 'Remove trust' : 'Trust this account'}</button>
  );
  // The account a request or a report is about: what decides between answering, trusting and pausing.
  const about = (x: any) => (x.about_account
    ? <div className="small" style={{ margin: '4px 0 8px' }}>Account <b>{x.account_name}</b> · {plan(x.account_plan)} · created {fmtDate(x.account_created_at)} · {x.account_trusted_at ? `trusted since ${fmtDate(x.account_trusted_at)}` : 'not trusted'}{x.suspended_at ? ' · paused' : ''}</div>
    : <div className="small muted" style={{ margin: '4px 0 8px' }}>No account goes with this address: they were not signed in, and no confirmed account owner uses it.</div>);
  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">Review queue</h1><div className="muted">Every item here is a person waiting. Reply by email, then close it.</div></div><button className="btn" onClick={reload}>Refresh</button></div>

      <BillingTools />

      <div className="card pad0">
        <div style={{ padding: '14px 16px' }}><h2>Help requests <span className="muted" style={{ fontWeight: 400 }}>({q.support.length})</span></h2></div>
        {q.support.length === 0 && <div className="empty" style={{ padding: 24 }}>Nobody is waiting.</div>}
        {q.support.map((s: any) => (
          <div key={s.id} className="queue-item">
            <div className="row between wrap"><b>{s.name || 'Someone'} · {s.email}</b><span className="muted small">{s.topic} · {fmtDate(s.at, true)} · ref {s.ref || s.id.slice(-8).toUpperCase()}</span></div>
            {!!s.forget && <div className="muted small">This person has deleted their account since. The request was kept so it can be answered, and it is deleted when you mark it as answered.</div>}
            {about(s)}
            <pre>{s.message}</pre>
            <div className="row wrap">
              <a className="btn sm primary" href={`mailto:${s.email}?subject=${encodeURIComponent(`Re: your Sign&Grow request ${s.ref || s.id.slice(-8).toUpperCase()}`)}`}>Reply by email</a>
              <button className="btn sm" onClick={() => act(api(`/operator/support/${s.id}`, { body: { status: 'closed' } }), 'Closed')}>Mark as answered</button>
              {s.about_account && trustButton(s.about_account, s.account_name, s.account_trusted_at)}
              {s.envelope_id && <span className="muted small mono">{s.envelope_id}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="card pad0">
        <div style={{ padding: '14px 16px' }}><h2>Reports from recipients <span className="muted" style={{ fontWeight: 400 }}>({q.reports.length})</span></h2><div className="muted small">Three different recipients reporting one account pauses it automatically. Reports you mark as abuse keep counting towards that. Reports you dismiss do not.</div></div>
        {q.reports.length === 0 && <div className="empty" style={{ padding: 24 }}>No open reports.</div>}
        {q.reports.map((r: any) => (
          <div key={r.id} className="queue-item">
            <div className="row between wrap"><b>{r.subject}</b><span className="muted small">{r.reason} · {fmtDate(r.at, true)}</span></div>
            <div className="small">Sent by {r.sender_name} ({r.sender_email}). Reported by {r.reporter}.</div>
            {about(r)}
            {r.message && <pre>{r.message}</pre>}
            {r.detail && <div className="small" style={{ marginBottom: 10 }}>The recipient wrote: {r.detail}</div>}
            <div className="row wrap">
              <button className="btn sm" onClick={() => act(api(`/operator/reports/${r.id}`, { body: { status: 'dismissed' } }), 'Dismissed')}>Nothing wrong</button>
              <button className="btn sm" onClick={() => act(api(`/operator/reports/${r.id}`, { body: { status: 'upheld' } }), 'Marked as abuse')}>This was abuse</button>
              {!r.suspended_at && <button className="btn sm danger" onClick={() => pause(r.account_id, r.account_name)}>Pause this sender</button>}
              {trustButton(r.account_id, r.account_name, r.account_trusted_at)}
              <a className="btn sm ghost" href={`mailto:${r.reporter}`}>Email the reporter</a>
            </div>
          </div>
        ))}
      </div>

      <div className="card pad0">
        <div style={{ padding: '14px 16px' }}><h2>Paused accounts <span className="muted" style={{ fontWeight: 400 }}>({q.paused.length})</span></h2><div className="muted small">Pausing stops everything that emails a recipient: new sends, new or changed recipients, reminders and reopening. The account keeps every document and can export, and people who already have a document can still sign it. Lifting a pause closes the reports that led to it.</div></div>
        {q.paused.length === 0 && <div className="empty" style={{ padding: 24 }}>No accounts are paused.</div>}
        {q.paused.map((a: any) => (
          <div key={a.id} className="queue-item row between wrap">
            <div><b>{a.name}</b> <span className="muted small">{plan(a.plan)} · created {fmtDate(a.created_at)} · {a.trusted_at ? `trusted since ${fmtDate(a.trusted_at)}` : 'not trusted'} · paused {fmtDate(a.suspended_at, true)}</span><div className="small">{a.suspended_reason}</div></div>
            <div className="row wrap">
              {trustButton(a.id, a.name, a.trusted_at)}
              <button className="btn sm primary" onClick={() => act(api(`/operator/accounts/${a.id}`, { body: { paused: false } }), 'Sending is back on. The account admins were emailed.')}>Lift the pause</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
