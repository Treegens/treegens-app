'use client';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';

// The queue for the people who run the service: help requests, reports from recipients, and paused accounts.
// Only visible to the addresses listed in OPERATOR_EMAILS.
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

      <div className="card pad0">
        <div style={{ padding: '14px 16px' }}><h2>Help requests <span className="muted" style={{ fontWeight: 400 }}>({q.support.length})</span></h2></div>
        {q.support.length === 0 && <div className="empty" style={{ padding: 24 }}>Nobody is waiting.</div>}
        {q.support.map((s: any) => (
          <div key={s.id} className="queue-item">
            <div className="row between wrap"><b>{s.name || 'Someone'} · {s.email}</b><span className="muted small">{s.topic} · {fmtDate(s.at, true)} · ref {s.id.slice(-8).toUpperCase()}</span></div>
            {about(s)}
            <pre>{s.message}</pre>
            <div className="row wrap">
              <a className="btn sm primary" href={`mailto:${s.email}?subject=${encodeURIComponent(`Re: your Sign&Grow request ${s.id.slice(-8).toUpperCase()}`)}`}>Reply by email</a>
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
