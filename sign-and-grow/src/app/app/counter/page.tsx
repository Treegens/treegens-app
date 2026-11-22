'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, useLoad, fmtDate, oops } from '@/components/ui';
import { Visit } from '@/components/counter/Visit';
import { CANNOT_CHECK_ID } from '@/lib/counter';
import '../../styles/counter.css';

// The Counter (research/government.json, G18): the queue view of signing in person, for officials an admin gave the
// counter permission. Start the person in front of you, from the list or from a counter template.
export default function CounterPage() {
  return <Suspense fallback={<div className="muted" role="status">Loading…</div>}><Counter /></Suspense>;
}

function Counter() {
  const q = useSearchParams();
  const visit = q.get('visit');
  return <div className="ct-page" data-feature="gov-G18">{visit ? <Visit id={visit} /> : <Queue />}</div>;
}

function Queue() {
  const router = useRouter();
  const [d, , err] = useLoad(() => api('/counter'));
  const [f, setF] = useState({ template_id: '', name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const go = (vid: string) => router.push(`/app/counter?visit=${encodeURIComponent(vid)}`);
  if (err) return <div className="card"><h1 className="serif">Counter</h1><p>{err.message}</p></div>;
  if (!d) return <p className="muted">Loading…</p>;
  const tpl = f.template_id || (d.templates.length === 1 ? d.templates[0].id : '');
  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      go((await api('/counter/start', { body: { ...f, template_id: tpl } })).visit_id);
    } catch (x) {
      oops(x);
      setBusy(false);
    }
  }
  const take = (x: any) => api('/counter/visits', { body: { envelope_id: x.envelope_id, recipient_id: x.recipient_id } }).then((r) => go(r.visit_id)).catch(oops);
  return (
    <div className="stack">
      <div>
        <h1 className="serif">Counter</h1>
        <p className="muted ct-note">{d.note || CANNOT_CHECK_ID}</p>
      </div>
      {d.templates.length === 0 && (
        <div className="card stack">
          <h2>Someone new</h2>
          <p style={{ margin: 0 }}>No document is set up for the counter yet. An admin picks one in Settings, Team, More options, Service counter.</p>
          {d.can_set_up && <div><Link className="btn" href="/app/settings?tab=team">Open Settings, Team</Link></div>}
        </div>
      )}
      {d.templates.length > 0 && (
        <form className="card stack" onSubmit={start} noValidate>
          <h2>Someone new</h2>
          {d.templates.length > 1 && (
            <label className="f"><span>Document</span>
              <select value={tpl} onChange={(e) => setF({ ...f, template_id: e.target.value })} required>
                <option value="">Choose…</option>
                {d.templates.map((t: any) => <option key={t.id} value={t.id}>{t.subject}</option>)}
              </select>
            </label>
          )}
          {d.templates.length === 1 && <p style={{ margin: 0 }}>{d.templates[0].subject}</p>}
          <label className="f"><span>Full name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="off" maxLength={120} required /></label>
          <label className="f"><span>Email for their copy</span><span className="hint">Needed: their signed copy is sent there.</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" maxLength={254} required /></label>
          <div><button className="btn primary" disabled={busy || !tpl}>Start</button></div>
        </form>
      )}
      <div className="card">
        <h2>Waiting</h2>
        {d.waiting.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nobody is waiting on a counter document.</p> : d.waiting.map((x: any) => (
          <div key={x.recipient_id} className="ct-row">
            <div className="ct-who"><b>{x.name}</b><div className="muted small">{x.subject}{x.with ? ` · with ${x.mine ? 'you' : x.with}` : ''}{x.waiting_second ? ' · needs a second official' : ''}</div></div>
            {x.mine ? <button type="button" className="btn" onClick={() => go(x.visit_id)} aria-label={`Continue with ${x.name}`}>Continue</button>
              : x.waiting_second ? <button type="button" className="btn" onClick={() => go(x.visit_id)} aria-label={`Confirm for ${x.name}`}>Confirm</button>
              : <button type="button" className="btn" onClick={() => take(x)} aria-label={`Start with ${x.name}`}>Start</button>}
          </div>
        ))}
      </div>
      {d.finished.length > 0 && (
        <details className="card" data-fold="">
          <summary><b>Finished today</b> <span className="muted small">{d.finished.length}</span></summary>
          {d.finished.map((x: any) => (
            <div key={x.recipient_id} className="ct-row">
              <div className="ct-who"><b>{x.name}</b><div className="muted small">{x.subject} · {fmtDate(x.completed_at, true)}</div></div>
              {x.visit_id && <button type="button" className="btn ghost" onClick={() => go(x.visit_id)} aria-label={`Receipt for ${x.name}`}>Receipt</button>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
