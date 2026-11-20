'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { api, useLoad, Leaf } from '@/components/ui';
import { QrOwnPhone } from '@/components/QrOwnPhone';

export default function PowerForm() {
  const { slug } = useParams<{ slug: string }>();
  const [form, , error] = useLoad(() => api(`/public/powerforms/${slug}`), [slug]);
  const [f, setF] = useState({ name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [queued, setQueued] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const r = await api(`/public/powerforms/${slug}/start`, { body: f });
      // On a shared device the form page is replaced, not stacked: Back must never bring up what the person before
      // typed, and after "Start a new form for the next person" nothing of theirs is left in this tab's history.
      if (r.url) form?.shared_device ? window.location.replace(r.url) : window.location.assign(r.url);
      else setQueued(true);
    } catch (err: any) {
      setMsg(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="authbox">
      {error ? <div className="card center"><h2>This form is not available</h2><p className="muted" style={{ marginTop: 8 }}>It may have been paused or removed by its owner.</p></div>
        : !form ? <div className="muted center">Loading…</div>
        : form.closed ? <div className="card center"><h2>This form cannot take new signatures right now</h2><p className="muted" style={{ marginTop: 8 }}>Please contact whoever gave you the link.</p></div>
        : queued ? <div className="card center"><h2>Thank you</h2><p className="muted" style={{ marginTop: 8 }}>We will email {f.email} as soon as the document is ready for you to sign.</p></div>
        : (
          <form className="card" onSubmit={start}>
            <div className="row" style={{ marginBottom: 12 }}>
              {form.brand?.brand_logo ? <img src={form.brand.brand_logo} alt={form.brand.name} style={{ maxHeight: 36 }} /> : <Leaf color="#1f6f43" size={24} />}
              <span className="muted small">{form.brand?.name}</span>
            </div>
            <h1 className="serif" style={{ fontSize: 24 }}>{form.name}</h1>
            <p className="muted" style={{ margin: '8px 0 16px' }}>Enter your details to review and sign. It takes a minute, and no paper is involved.</p>
            {/* A shared device must not offer the next person the names and addresses typed before: no autofill there. */}
            <label className="f"><span>Your full name</span><input dir="auto" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete={form.shared_device ? 'off' : 'name'} autoFocus /></label>
            <label className="f"><span>Your email <span className="hint">(we send your signed copy here)</span></span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete={form.shared_device ? 'off' : 'email'} /></label>
            {msg && <div className="notice err" style={{ marginBottom: 12 }} role="alert">{msg}</div>}
            <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Preparing your document…' : 'Continue to sign'}</button>
            {/* On a big screen (a tablet at a front desk): a code that opens this same form on the visitor's own phone. */}
            <QrOwnPhone slug={slug} name={form.name} />
          </form>
        )}
      <p className="muted small center" style={{ marginTop: 14 }}>Powered by Sign&Grow, where every dollar plants mangrove trees. <a href="/help?topic=signing#contact">Something not working? Get help</a></p>
    </div>
  );
}
