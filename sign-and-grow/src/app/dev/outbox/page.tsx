'use client';
import { useState } from 'react';
import { api, useLoad, fmtDate } from '@/components/ui';

// Local development only: shows every email the app "sent" when no SMTP server is configured.
export default function Outbox() {
  const [d, reload, error] = useLoad(() => api('/dev/outbox'));
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <div className="authbox"><div className="card center"><h2>Outbox is off</h2><p className="muted">It is only available in development, or when no mail server is configured and DEV_OUTBOX=1 is set.</p></div></div>;
  return (
    <div className="wrap" style={{ padding: '24px 20px' }}>
      <div className="pagehead"><div><h1 className="serif">Dev outbox</h1><div className="muted">No mail server is configured, so emails land here instead of being delivered.</div></div><button className="btn" onClick={reload}>Refresh</button></div>
      <div className="grid g2">
        <div className="card pad0" style={{ maxHeight: '75vh', overflow: 'auto' }}>
          <table className="t"><tbody>
            {(d?.emails || []).map((m: any) => (
              <tr key={m.id} className="click" onClick={() => setOpen(m.id)} style={open === m.id ? { background: 'var(--green-soft)' } : undefined}>
                <td><b>{m.subject}</b><div className="muted small">To {m.to_email} · {fmtDate(m.at, true)}</div>{m.link && <a className="small" href={m.link} onClick={(e) => e.stopPropagation()} data-outbox-link>{m.link.replace(/^https?:\/\/[^/]+/, '')}</a>}</td>
              </tr>
            ))}
            {d && d.emails.length === 0 && <tr><td className="muted">Nothing sent yet.</td></tr>}
          </tbody></table>
        </div>
        <div className="card pad0" style={{ minHeight: 400 }}>{open ? <iframe title="Email preview" src={`/api/dev/outbox?id=${open}`} sandbox="" style={{ width: '100%', height: '75vh', border: 0 }} /> : <div className="empty">Select an email to preview it.</div>}</div>
      </div>
      {/* Text messages, when this machine has them switched on without a provider (SMS_DEV_OUTBOX=1): the text as
          a phone would get it, with the number masked. A code is read from here, like a link from an email above. */}
      {(d?.texts || []).length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 style={{ marginBottom: 4 }}>Text messages</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Nothing here was delivered to a phone unless its status says sent.</p>
          <table className="t" data-outbox-texts><tbody>
            {d.texts.map((t: any) => (
              <tr key={t.id}>
                <td><b>{t.kind === 'code' ? 'One-time code' : t.kind === 'reminder' ? 'Reminder' : 'Signing link'}</b> <span className="muted small">to {t.to} · {t.status} · {fmtDate(t.at, true)}</span><p className="ob-text" data-outbox-text>{t.body}</p></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </div>
  );
}
